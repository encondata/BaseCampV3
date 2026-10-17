/** The shared shell for every kiosk-settings Edit modal: the report-generate
 *  header (eyebrow, title, description), a content-sized card, Save/Cancel,
 *  and the 422 mapping. A `bad_config` 422 names a dotted field
 *  (`appearance.flash_ms`); the field that owns it shows the message beside
 *  its control, and anything no field claims shows above the form. */

import { useState, type FormEvent, type ReactNode } from 'react';

import { ApiError } from '../../../lib/api';

export interface FieldErrorState { field: string | null; message: string }

/** True when `field` (from the server) belongs to the control at `path`. */
export const fieldMatches = (field: string | null, path: string) =>
  field !== null && (field === path || field.startsWith(`${path}.`));

export function errorFromApi(err: unknown): FieldErrorState {
  if (err instanceof ApiError) {
    const d = err.detail as { field?: unknown; message?: unknown } | undefined;
    if (err.status === 422 && d && typeof d === 'object') {
      const field = typeof d.field === 'string' ? d.field : null;
      const message = typeof d.message === 'string' ? d.message : 'That value is not allowed.';
      return { field, message };
    }
    if (err.code === 'forbidden_rank' || err.code === 'forbidden') {
      return { field: null, message: 'Only super admins can change kiosk settings.' };
    }
    if (err.code === 'read_only_mode') return { field: null, message: err.message };
    return { field: null, message: `Couldn't save (${err.code}).` };
  }
  return { field: null, message: "Couldn't reach the server. Nothing was saved." };
}

export function FieldError({ error, path }: { error: FieldErrorState | null; path: string }) {
  if (!error || !fieldMatches(error.field, path)) return null;
  return <p className="pf-error" role="alert">{error.message}</p>;
}

export default function SectionEditModal({
  title, kioskName, description, fields, onSave, onClose, children,
}: {
  title: string;
  kioskName: string;
  description: string;
  /** The dotted config paths this modal's controls own. */
  fields: string[];
  onSave: () => Promise<void>;
  onClose: () => void;
  children: (error: FieldErrorState | null) => ReactNode;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<FieldErrorState | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave();
    } catch (err) {
      setError(errorFromApi(err));
    } finally {
      setSaving(false);
    }
  };

  const claimed = error !== null && fields.some((p) => fieldMatches(error.field, p));

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card kd-modal-card" role="dialog" aria-label={title}>
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Kiosk settings · {kioskName}</div>
            <h3>{title}</h3>
            <p className="page-hint">{description}</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            {error && !claimed && <p className="pf-error kd-modal-error" role="alert">{error.message}</p>}
            {children(error)}
          </div>
          <div className="modal-foot">
            <button type="submit" className="btn-solid" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
