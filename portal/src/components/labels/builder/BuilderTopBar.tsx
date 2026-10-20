/**
 * The label builder's top bar (the agreed layout, builder-layout-v4): the
 * template's name, a Type · size chip, what it is in the DPI tree — a
 * parent with its DPIs ("Parent (203 · 300 · 600)", each one a button that
 * shows the label at that DPI) or one child ("Child · 300") — the version,
 * an Unsaved mark while there are changes, undo and redo, then Versions,
 * Clone, Test print and Save with their keys.
 */

import { SHORTCUTS, type Platform } from '../../../labels/builder/shortcuts';
import '../../../styles/directory.css';
import '../../../styles/labelBuilder.css';

export type BuilderRole =
  | { kind: 'parent'; dpis: readonly string[]; viewDpi: string; onViewDpi: (dpi: string) => void }
  | { kind: 'child'; dpi: string };

export interface BuilderTopBarProps {
  name: string;
  /** The label type and size as the chip reads them ("Top · 4" x 2""). */
  typeSize: string;
  role: BuilderRole;
  /** v7, or a child's v7.2. */
  version: string;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onBack: () => void;
  onVersions: () => void;
  /** Absent: no Clone (a DPI child). */
  onClone?: () => void;
  /** Why Clone is off just now (unsaved changes). */
  cloneBlocked?: string | null;
  onTestPrint: () => void;
  /** Why Test print is off (not a ZPL template). */
  printBlocked?: string | null;
  onSave: () => void;
  saving?: boolean;
  printing?: boolean;
  /** An old version is open: nothing to save. */
  readOnly?: boolean;
  platform: Platform;
}

function keysOf(id: string, platform: Platform): string {
  const s = SHORTCUTS.find((x) => x.id === id);
  return s ? (platform === 'mac' ? s.mac : s.win) : '';
}

const UNDO_ICON = <path d="M6 7H12.5a4.5 4.5 0 0 1 0 9H8M6 7l3-3M6 7l3 3" />;
const REDO_ICON = <path d="M14 7H7.5a4.5 4.5 0 0 0 0 9H12M14 7l-3-3M14 7l-3 3" />;

export default function BuilderTopBar({
  name, typeSize, role, version, dirty, canUndo, canRedo, onUndo, onRedo, onBack, onVersions, onClone,
  cloneBlocked = null, onTestPrint, printBlocked = null, onSave, saving = false, printing = false,
  readOnly = false, platform,
}: BuilderTopBarProps) {
  const undoKeys = keysOf('edit.undo', platform);
  const redoKeys = keysOf('edit.redo', platform);
  const printKeys = keysOf('workflow.testPrint', platform);
  const saveKeys = keysOf('workflow.save', platform);
  return (
    <div className="lbb-bar" role="group" aria-label="Template">
      <button type="button" className="mini-btn" onClick={onBack}>← Templates</button>
      <b className="lbb-name" title={name}>{name}</b>
      <span className="chip tag">{typeSize}</span>
      {role.kind === 'parent' ? (
        <span className="chip c-blue lbb-dpis" title="Shown at the highlighted DPI; click another to switch">
          {/* one flex item, so the separators keep their spaces */}
          <span>
            Parent (
            {role.dpis.map((dpi, i) => (
              <span key={dpi}>
                {i > 0 && ' · '}
                <button type="button" className={`lbb-dpi${dpi === role.viewDpi ? ' on' : ''}`}
                  aria-pressed={dpi === role.viewDpi} aria-label={`Show at ${dpi} DPI`}
                  onClick={() => role.onViewDpi(dpi)}>{dpi}</button>
              </span>
            ))}
            )
          </span>
        </span>
      ) : (
        <span className="chip c-blue">Child · {role.dpi}</span>
      )}
      <span className="chip c-violet" aria-label={`Version ${version}`}>{version}</span>
      {dirty && <span className="chip c-amber">Unsaved</span>}
      <span className="lbb-group">
        <button type="button" className="mini-btn lbb-icon-btn" aria-label="Undo" title={`Undo · ${undoKeys}`}
          disabled={!canUndo || readOnly} onClick={onUndo}>
          <svg className="lbb-icon" viewBox="0 0 20 20" aria-hidden="true">{UNDO_ICON}</svg>
        </button>
        <button type="button" className="mini-btn lbb-icon-btn" aria-label="Redo" title={`Redo · ${redoKeys}`}
          disabled={!canRedo || readOnly} onClick={onRedo}>
          <svg className="lbb-icon" viewBox="0 0 20 20" aria-hidden="true">{REDO_ICON}</svg>
        </button>
      </span>
      <span className="lbb-spacer" />
      <button type="button" className="mini-btn" onClick={onVersions}>Versions</button>
      {onClone && (
        <button type="button" className="mini-btn" onClick={onClone} disabled={!!cloneBlocked}
          title={cloneBlocked ?? 'Clone to a new template'}>Clone</button>
      )}
      <button type="button" className="mini-btn" onClick={onTestPrint} disabled={printing || !!printBlocked}
        title={printBlocked ?? 'Print this label with its sample values on a USB Zebra printer'}>
        {printing ? 'Printing…' : 'Test print'} <kbd className="lbp-kbd">{printKeys}</kbd>
      </button>
      <button type="button" className="btn-solid lbb-save" onClick={onSave} disabled={saving || readOnly}>
        {saving ? 'Saving…' : 'Save'} <kbd className="lbp-kbd">{saveKeys}</kbd>
      </button>
    </div>
  );
}
