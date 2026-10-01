import { useEffect } from 'react';

import DataTable from '@portal/components/DataTable';
import { exportCsv } from '@portal/lib/listTools';

import type { ImportRow, ImportRun } from '../lib/sirdarApi';

const ACTION_LABEL: Record<ImportRow['action'], string> = {
  added: 'Added', updated: 'Updated', unchanged: 'Unchanged', disabled: 'Disabled', skipped: 'Skipped',
};
const REASON_TEXT: Record<string, string> = {
  not_eligible: 'No longer has an admin-or-higher role in the portal',
  email_collision_local: 'A local user already has this email',
  email_collision: 'Another Sirdar user already has this email',
  person_is_local: 'This person is a local Sirdar user',
};

export function rowDetail(r: ImportRow): string {
  if (r.reason) return REASON_TEXT[r.reason] ?? r.reason;
  if (r.changes.length) return `Changed: ${r.changes.join(', ').replaceAll('_', ' ')}`;
  return '';
}

export default function ImportSummaryModal({ run, onClose }: { run: ImportRun; onClose: () => void }) {
  const counts: [string, number][] = [
    ['Added', run.added], ['Updated', run.updated], ['Unchanged', run.unchanged],
    ['Disabled', run.disabled], ['Skipped', run.skipped],
  ];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card sirdar-import-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-import-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Import from portal</div>
            <h3 id="sirdar-import-title">Import finished</h3>
            <p className="page-hint">
              Portal users with an admin-or-higher role are copied into Sirdar. People who lost that
              role are disabled here; local users are never changed.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="sirdar-stats">
            {counts.map(([label, n]) => (
              <div key={label} className="sirdar-stat"><b>{n}</b><span>{label}</span></div>
            ))}
          </div>
          <DataTable
            ariaLabel="Import results"
            columns={[
              { key: 'name', label: 'Name' }, { key: 'email', label: 'Email', mono: true },
              { key: 'result', label: 'Result' }, { key: 'roles', label: 'Roles' },
              { key: 'detail', label: 'Detail' },
            ]}
            rows={run.rows.map((r, i) => ({
              key: `${r.email}-${i}`,
              cells: [r.name, r.email, ACTION_LABEL[r.action], r.roles.join(', ') || '—', rowDetail(r) || '—'],
            }))}
            emptyText="Nobody in the portal qualifies yet."
          />
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" onClick={() => exportCsv(
            `sirdar-import-${run.id}.csv`,
            [['Name', (r: ImportRow) => r.name], ['Email', (r: ImportRow) => r.email],
             ['Result', (r: ImportRow) => ACTION_LABEL[r.action]],
             ['Roles', (r: ImportRow) => r.roles.join('; ')],
             ['Detail', (r: ImportRow) => rowDetail(r)]],
            run.rows)}>
            Download CSV
          </button>
          <button type="button" className="btn-solid" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
