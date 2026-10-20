/**
 * The templates list's small dialogs (spec §3.4, §4.1, §4.9), each with the
 * report-generate header and sized to its content:
 *  - ListDialog: the shared frame (DeleteTemplateModal and
 *    ReplaceTemplateModal use it too).
 *  - SitesModal: a parent's sites (its children follow them).
 *  - AddDpiModal: brings back a DPI the parent lost to "Delete this DPI".
 *  - UpdateFromParentModal: a customized child gives way to a fresh one
 *    from the parent and is kept, inactive, as "… Old".
 *  - DeactivateTemplateModal: names what goes off and warns, like Delete,
 *    when it leaves no active Generic Rack and RU at a DPI (FallbackCallout).
 *  - RenameTemplateModal: Rename… for an inactive parent (its DPI versions
 *    follow, previewed live) or an older single row.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import TagInput from '../TagInput';
import {
  ApiError, addLabelTemplateDpi, deleteLabelTemplate, getLabelTemplateDeactivateSummary, updateLabelTemplate,
  updateLabelTemplateFromParent,
  type LabelTemplate, type LabelTemplateDeactivateSummary, type SiteItem,
} from '../../lib/api';
import '../../styles/directory.css';
import '../../styles/profile.css';   /* .pf-form, .btn-solid, .pf-error */
import '../../styles/reports.css';
import '../../styles/labels.css';

export function ListDialog({ label, eyebrow, title, hint, card, busy = false, onClose, children, foot }: {
  label: string; eyebrow: string; title: string; hint: ReactNode; card: string; busy?: boolean;
  onClose: () => void; children?: ReactNode; foot: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className={`modal-card reports-modal-card rgm-card ${card}`} role="dialog" aria-modal="true" aria-label={label}>
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">{eyebrow}</div>
            <h3>{title}</h3>
            <p className="page-hint">{hint}</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        {children && <div className="modal-body">{children}</div>}
        <div className="modal-foot">{foot}</div>
      </div>
    </div>
  );
}

export function SitesModal({ template, sites, onSaved, onClose }: {
  template: Pick<LabelTemplate, 'id' | 'name' | 'site_ids'>;
  sites: SiteItem[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const [siteIds, setSiteIds] = useState<string[]>(template.site_ids);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateLabelTemplate(template.id, { site_ids: siteIds });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'active_conflict'
        ? 'Another active template already prints this family, type and DPI.'
        : "Couldn't save the sites.");
      setBusy(false);
    }
  };
  return (
    <ListDialog label="Template sites" eyebrow={`${template.name} · Sites`} title="Sites" card="lt-small-card"
      busy={busy} onClose={onClose}
      hint="Where this template prints. With no sites it prints everywhere; its DPI versions follow it."
      foot={(
        <>
          <button type="button" className="btn-solid" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </>
      )}>
      <div className="lt-sites">
        <TagInput value={siteIds} onChange={setSiteIds} disabled={busy}
          options={sites.map((s) => ({ value: s.id, label: s.name }))}
          placeholder={siteIds.length ? 'Add a site…' : 'All sites — add to narrow'} />
      </div>
    </ListDialog>
  );
}

export function AddDpiModal({ template, missing, onAdded, onClose }: {
  template: Pick<LabelTemplate, 'id' | 'name'>;
  /** The DPIs the parent has no current child for, in DPI order. */
  missing: string[];
  onAdded: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = async (dpi: string) => {
    setBusy(dpi);
    setError(null);
    try {
      await addLabelTemplateDpi(template.id, dpi);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'active_conflict'
        ? `Another active template already prints ${template.name} at ${dpi} DPI.`
        : `Couldn't add ${dpi} DPI.`);
      setBusy(null);
    }
  };
  return (
    <ListDialog label="Add a DPI" eyebrow={`${template.name} · Add DPI`} title="Add a DPI" card="lt-small-card"
      busy={busy !== null} onClose={onClose}
      hint="A fresh DPI version, generated from the template's current design."
      foot={(
        <>
          {missing.map((dpi) => (
            <button key={dpi} type="button" className="btn-solid" disabled={busy !== null} onClick={() => void add(dpi)}>
              {busy === dpi ? 'Adding…' : `Add ${dpi} DPI`}
            </button>
          ))}
          <button type="button" className="mini-btn" onClick={onClose} disabled={busy !== null}>Cancel</button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </>
      )} />
  );
}

export function UpdateFromParentModal({ child, parentVersion, keptName, onUpdated, onClose }: {
  child: Pick<LabelTemplate, 'id' | 'name'>;
  /** The parent's version (v7). */
  parentVersion: string;
  /** The name the customized child keeps ("… · 300 Old"). */
  keptName: string;
  onUpdated: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateLabelTemplateFromParent(child.id);
      onUpdated();
    } catch {
      setError("Couldn't update it from the parent.");
      setBusy(false);
    }
  };
  return (
    <ListDialog label="Update from parent" eyebrow={`${child.name} · Update`} title="Update from parent?"
      card="lt-small-card" busy={busy} onClose={onClose}
      hint={<>This DPI has its own edits, so it doesn&apos;t follow the parent. Updating makes a fresh one
        from {parentVersion} and keeps the edited one, inactive, as <b>{keptName}</b> under the same parent.</>}
      foot={(
        <>
          <button type="button" className="btn-solid" disabled={busy} onClick={() => void update()}>
            {busy ? 'Updating…' : 'Update from parent'}
          </button>
          <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </>
      )} />
  );
}

/** "a", "a and b", "a, b and c". */
export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "203 DPI", "203 and 300 DPI", "203, 300 and 600 DPI" (the API's natural
 *  order kept). */
export const fallbackDpiText = (dpis: readonly string[]) => `${joinAnd(dpis)} DPI`;

/** The amber warning on Delete and Deactivate when the change leaves no
 *  active Generic Rack and RU — the template every move without its own Top
 *  template prints from — at a DPI (`fallback_dpis_lost`). Nothing when the
 *  list is empty; the change itself stays allowed. */
export function FallbackCallout({ dpis }: { dpis: readonly string[] }) {
  if (!dpis.length) return null;
  return (
    <div className="lt-fallback-note" role="note">
      This is the only active Generic Rack and RU template at {fallbackDpiText(dpis)}. Moves without their own
      Top template will have nothing to print at {dpis.length > 1 ? 'those DPIs' : 'that DPI'} until another one
      is active. To swap templates without a gap, use Replace…
    </div>
  );
}

function deactivateError(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) return 'This template no longer exists.';
  return "Couldn't deactivate the template.";
}

export function DeactivateTemplateModal({ template, onDeactivated, onClose }: {
  /** A top-level template: a builder parent (its current DPI versions go off
   *  with it) or an older single row. */
  template: Pick<LabelTemplate, 'id' | 'name'>;
  onDeactivated: () => void;
  onClose: () => void;
}) {
  const [summary, setSummary] = useState<LabelTemplateDeactivateSummary | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let live = true;
    setLoadError(false);
    getLabelTemplateDeactivateSummary(template.id)
      .then((s) => { if (live) setSummary(s); })
      .catch(() => { if (live) setLoadError(true); });
    return () => { live = false; };
  }, [template.id]);

  useEffect(() => load(), [load]);

  const deactivate = async () => {
    if (!summary || busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteLabelTemplate(template.id);   // POST …/deactivate
      onDeactivated();
    } catch (err) {
      setError(deactivateError(err));
      setBusy(false);
    }
  };

  const hint = summary === null
    ? (loadError ? 'Kiosks stop printing from it until it is activated again.' : 'Checking what goes off…')
    : summary.rows.length ? `Turns off ${joinAnd(summary.rows)}.` : 'It is already off.';

  return (
    <ListDialog label="Deactivate template" eyebrow={`${template.name} · Deactivate`} title="Deactivate"
      hint={hint} card="lt-small-card" busy={busy} onClose={onClose}
      foot={(
        <>
          <button type="button" className="btn-solid" disabled={!summary || busy} onClick={() => void deactivate()}>
            {busy ? 'Deactivating…' : 'Deactivate'}
          </button>
          <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </>
      )}>
      {loadError ? (
        <div className="lt-delete-load">
          <span className="pf-error">Couldn&apos;t check what goes off.</span>
          <button type="button" className="mini-btn" onClick={load}>Retry</button>
        </div>
      ) : summary?.fallback_dpis_lost.length ? (
        <FallbackCallout dpis={summary.fallback_dpis_lost} />
      ) : null}
    </ListDialog>
  );
}

/** A DPI version as Rename… previews it. */
export interface RenamedChild { name: string; dpi_key: string; is_old?: boolean }

/** What a parent's DPI version is called once the parent is `name` (the
 *  API's rename_parent rule: the part after the parent's old name is kept,
 *  " · <dpi>" and " Old" when the name doesn't start with it). */
export function renamedChildName(oldParent: string, name: string, child: RenamedChild): string {
  const suffix = child.name.startsWith(oldParent)
    ? child.name.slice(oldParent.length)
    : ` · ${child.dpi_key}${child.is_old ? ' Old' : ''}`;
  return `${name}${suffix}`;
}

function renameError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'name_taken' || err.code === 'label_template_exists') {
      return 'That name is already used by another template.';
    }
    if (err.code === 'template_active') return 'This template was activated; deactivate it to rename it.';
    if (err.status === 404) return 'This template no longer exists.';
  }
  return "Couldn't rename the template.";
}

export function RenameTemplateModal({ template, dpiChildren = [], onRenamed, onClose }: {
  /** An inactive top-level template: a builder parent or an older row. */
  template: Pick<LabelTemplate, 'id' | 'name'>;
  /** A parent's DPI versions (current and Old), for the preview. */
  dpiChildren?: RenamedChild[];
  onRenamed: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(template.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    box.current?.focus();
    box.current?.select();
  }, []);

  const next = name.trim();
  const ready = next !== '' && next !== template.name && !busy;
  const rename = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await updateLabelTemplate(template.id, { name: next });
      onRenamed();
    } catch (err) {
      setError(renameError(err));
      setBusy(false);
    }
  };

  const shown = next || template.name;
  return (
    <ListDialog label="Rename template" eyebrow={`${template.name} · Rename`} title="Rename" card="lt-small-card"
      busy={busy} onClose={onClose}
      hint={dpiChildren.length
        ? 'A new name for this template; its DPI versions take it too. Only an inactive template can be renamed.'
        : 'A new name for this template. Only an inactive template can be renamed.'}
      foot={(
        <>
          <button type="button" className="btn-solid" disabled={!ready} onClick={() => void rename()}>
            {busy ? 'Renaming…' : 'Rename'}
          </button>
          <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </>
      )}>
      <div className="lt-rename">
        <div className="pf-form">
          <div className="full">
            <label htmlFor="lt-rename-name">New name</label>
            <input id="lt-rename-name" ref={box} value={name} maxLength={120} autoComplete="off"
              spellCheck={false} disabled={busy} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void rename(); }} />
          </div>
        </div>
        {dpiChildren.length > 0 && (
          <div className="lt-rename-preview">
            <span className="page-hint">Its DPI versions become</span>
            <ul aria-label="DPI versions after the rename">
              {dpiChildren.map((c) => (
                <li key={c.name} className={`chip ${c.is_old ? 'c-slate' : 'tag'}`}>
                  {renamedChildName(template.name, shown, c)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </ListDialog>
  );
}
