/**
 * The label builder's top bar (the agreed layout, builder-layout-v4): the
 * template's name, a Type · size chip, what it is in the DPI tree — a
 * parent with its DPIs ("Parent (203 · 300 · 600)", each one a button that
 * shows the label at that DPI) or one child ("Child · 300") — the version,
 * an Unsaved mark while there are changes, undo and redo, then Versions,
 * Clone, Printer (the USB printer dialog), Test print and Save with their
 * keys. Every button has a hover tip (components/Tip.tsx): what it does,
 * its keys, and why it's off when it is; no native `title`, so never two
 * tooltips.
 */

import { shortcutKeys, type Platform } from '../../../labels/builder/shortcuts';
import Tip from '../../Tip';
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
  /** Opens the Printer dialog (connection, alignment label, fonts). */
  onPrinter: () => void;
  /** Why Test print and Printer are off (not a ZPL template). */
  printBlocked?: string | null;
  onSave: () => void;
  saving?: boolean;
  printing?: boolean;
  /** An old version is open: nothing to save. */
  readOnly?: boolean;
  platform: Platform;
}

/** Why editing controls are off while an older version is open. */
const READ_ONLY_NOTE = 'An older version is open.';

const UNDO_ICON = <path d="M6 7H12.5a4.5 4.5 0 0 1 0 9H8M6 7l3-3M6 7l3 3" />;
const REDO_ICON = <path d="M14 7H7.5a4.5 4.5 0 0 0 0 9H12M14 7l-3-3M14 7l-3 3" />;

export default function BuilderTopBar({
  name, typeSize, role, version, dirty, canUndo, canRedo, onUndo, onRedo, onBack, onVersions, onClone,
  cloneBlocked = null, onTestPrint, onPrinter, printBlocked = null, onSave, saving = false, printing = false,
  readOnly = false, platform,
}: BuilderTopBarProps) {
  const undoKeys = shortcutKeys('edit.undo', platform);
  const redoKeys = shortcutKeys('edit.redo', platform);
  const printKeys = shortcutKeys('workflow.testPrint', platform);
  const saveKeys = shortcutKeys('workflow.save', platform);
  return (
    <div className="lbb-bar" role="group" aria-label="Template">
      <Tip label="Back to the templates list">
        <button type="button" className="mini-btn" onClick={onBack}>← Templates</button>
      </Tip>
      <b className="lbb-name" title={name}>{name}</b>
      <span className="chip tag">{typeSize}</span>
      {role.kind === 'parent' ? (
        <span className="chip c-blue lbb-dpis">
          {/* one flex item, so the separators keep their spaces */}
          <span>
            Parent (
            {role.dpis.map((dpi, i) => (
              <span key={dpi}>
                {i > 0 && ' · '}
                <Tip label={`Show at ${dpi} DPI`}
                  note={dpi === role.viewDpi ? 'Shown at this DPI now; click another to switch.' : null}>
                  <button type="button" className={`lbb-dpi${dpi === role.viewDpi ? ' on' : ''}`}
                    aria-pressed={dpi === role.viewDpi} aria-label={`Show at ${dpi} DPI`}
                    onClick={() => role.onViewDpi(dpi)}>{dpi}</button>
                </Tip>
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
        <Tip label="Undo" keys={undoKeys} note={readOnly ? READ_ONLY_NOTE : canUndo ? null : 'Nothing to undo'}>
          <button type="button" className="mini-btn lbb-icon-btn" aria-label="Undo"
            disabled={!canUndo || readOnly} onClick={onUndo}>
            <svg className="lbb-icon" viewBox="0 0 20 20" aria-hidden="true">{UNDO_ICON}</svg>
          </button>
        </Tip>
        <Tip label="Redo" keys={redoKeys} note={readOnly ? READ_ONLY_NOTE : canRedo ? null : 'Nothing to redo'}>
          <button type="button" className="mini-btn lbb-icon-btn" aria-label="Redo"
            disabled={!canRedo || readOnly} onClick={onRedo}>
            <svg className="lbb-icon" viewBox="0 0 20 20" aria-hidden="true">{REDO_ICON}</svg>
          </button>
        </Tip>
      </span>
      <span className="lbb-spacer" />
      <Tip label="Saved versions of this template">
        <button type="button" className="mini-btn" onClick={onVersions}>Versions</button>
      </Tip>
      {onClone && (
        <Tip label="Clone to a new template" note={cloneBlocked}>
          <button type="button" className="mini-btn" onClick={onClone} disabled={!!cloneBlocked}>Clone</button>
        </Tip>
      )}
      <Tip label="Connect the USB printer, print an alignment label, check its fonts" note={printBlocked}>
        <button type="button" className="mini-btn" onClick={onPrinter} disabled={!!printBlocked}>Printer</button>
      </Tip>
      <Tip label="Print this label with its sample values on a USB Zebra printer" keys={printKeys} note={printBlocked}>
        <button type="button" className="mini-btn" onClick={onTestPrint} disabled={printing || !!printBlocked}>
          {printing ? 'Printing…' : 'Test print'} <kbd className="lbp-kbd">{printKeys}</kbd>
        </button>
      </Tip>
      <Tip label="Save" keys={saveKeys} note={readOnly ? 'An older version is open: nothing to save.' : null}>
        <button type="button" className="btn-solid lbb-save" onClick={onSave} disabled={saving || readOnly}>
          {saving ? 'Saving…' : 'Save'} <kbd className="lbp-kbd">{saveKeys}</kbd>
        </button>
      </Tip>
    </div>
  );
}
