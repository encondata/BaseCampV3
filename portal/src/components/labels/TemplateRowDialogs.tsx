/**
 * The templates list's small dialogs (spec §3.4, §4.1, §4.9), each with the
 * report-generate header and sized to its content:
 *  - ListDialog: the shared frame (DeleteTemplateModal and
 *    ReplaceTemplateModal use it too).
 *  - SitesModal: a parent's sites (its children follow them).
 *  - AddDpiModal: brings back a DPI the parent lost to "Delete this DPI".
 *  - UpdateFromParentModal: a customized child gives way to a fresh one
 *    from the parent and is kept, inactive, as "… Old".
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import TagInput from '../TagInput';
import {
  ApiError, addLabelTemplateDpi, updateLabelTemplate, updateLabelTemplateFromParent,
  type LabelTemplate, type SiteItem,
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
