/**
 * The builder's keyboard shortcuts (⌘/ or Ctrl+/, spec §5): every binding of
 * labels/builder/shortcuts.ts by group, as this platform writes it.
 */

import { useEffect } from 'react';

import { SHORTCUTS, type Platform, type Shortcut } from '../../../labels/builder/shortcuts';
import '../../../styles/directory.css';
import '../../../styles/reports.css';
import '../../../styles/labelBuilder.css';
import DataTable, { type DataTableColumn } from '../../DataTable';

const GROUPS: Shortcut['group'][] = ['Tools', 'Move and size', 'Edit', 'Format', 'Align', 'Canvas', 'Workflow'];

const COLUMNS: DataTableColumn[] = [
  { key: 'what', label: 'Action' },
  { key: 'keys', label: 'Keys', mono: true, align: 'right' },
];

export default function ShortcutSheet({ platform, onClose }: { platform: Platform; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card lbb-keys-card" role="dialog" aria-modal="true"
        aria-label="Keyboard shortcuts">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Label builder</div>
            <h3>Keyboard shortcuts</h3>
            <p className="page-hint">
              {platform === 'mac' ? '⌘' : 'Ctrl'} works everywhere on the page; the rest work when
              you aren&apos;t typing in a box.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body lbb-keys">
          {GROUPS.map((group) => (
            <section key={group} className="lbb-keys-group" aria-label={group}>
              <p className="lbb-keys-title">{group}</p>
              <DataTable columns={COLUMNS} ariaLabel={group} rows={SHORTCUTS.filter((s) => s.group === group).map((s) => ({
                key: s.id, cells: [s.label, platform === 'mac' ? s.mac : s.win],
              }))} />
            </section>
          ))}
        </div>
        <div className="modal-foot">
          <button type="button" className="mini-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
