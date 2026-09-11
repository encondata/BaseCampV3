/**
 * "Complete source site survey" — blocks Generate when the chosen source
 * site is missing required survey answers the template needs. Renders
 * one field per missing `kind` (bool → Yes/No segmented, int → number,
 * text/textarea, select → ComboBox), saves each via
 * `PUT /sites/{id}/survey/{field_key}` on Save, then hands control back
 * to the caller (which queues the run).
 */
import { useEffect, useState } from 'react';

import { ApiError, putSiteSurveyValue } from '../../lib/api';
import type { MissingSurveyField } from '../../lib/siteMoveSurvey';
import ComboBox from '../ComboBox';

type FieldValue = string | number | boolean | undefined;

function isFilled(field: MissingSurveyField, value: FieldValue): boolean {
  if (field.kind === 'bool') return typeof value === 'boolean';
  if (field.kind === 'int') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'string' && value.trim() !== '';
}

export default function CompleteSiteSurveyModal({
  siteName, fields, onSave, onCancel,
}: {
  siteName: string;
  fields: MissingSurveyField[];
  /** Persists the survey answers for `siteId` (called by the parent so
   *  the site id itself stays out of this component's props surface —
   *  it only needs to know how to save, not where). */
  onSave: (values: Record<string, FieldValue>) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (key: string, v: FieldValue) => setValues((prev) => ({ ...prev, [key]: v }));
  const remaining = fields.filter((f) => !isFilled(f, values[f.key])).length;
  // Every listed field is required (the parent already filtered the notes
  // group out), so the footer says how many are still blank rather than
  // leaving a silently disabled button.
  const ready = remaining === 0;

  // Registered on the CAPTURE phase so it runs before GenerateReportModal's
  // own bubble-phase Escape listener (both are on `document` — a later
  // bubble-phase listener never runs before an earlier capture-phase one,
  // regardless of attach order). Always marks the keypress handled
  // (preventDefault) so the outer modal's listener bails out and only
  // this inner prompt closes, even while `saving` — the outer modal never
  // sees an "unhandled" Escape while this one is open — but only actually
  // dismisses when not mid-save (matching the Cancel button's own guard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (!saving) onCancel();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [saving, onCancel]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await onSave(values);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the survey.");
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onCancel();
    }}>
      <div className="modal-card reports-modal-card">
        <div className="modal-head">
          <h3>Complete source site survey</h3>
          <button type="button" className="modal-close" aria-label="Close" onClick={onCancel}
                  disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <p className="page-hint">
            <b>{siteName}</b> is missing survey answers the template needs. Fill them in to
            continue.
          </p>
          <div className="pf-form">
            {fields.map((f) => (
              // bool/select have no single form control an htmlFor could
              // point at (a segmented button group; a ComboBox with an
              // unexposed input id) — those get a plain id'd label the
              // control group references via aria-labelledby instead of a
              // dangling `for`.
              <div key={f.key} style={f.kind === 'textarea' ? { gridColumn: '1 / -1' } : undefined}>
                {f.kind === 'int' || f.kind === 'text' || f.kind === 'textarea' ? (
                  <label htmlFor={`survey-${f.key}`}>{f.label}</label>
                ) : (
                  <label id={`survey-${f.key}-label`}>{f.label}</label>
                )}
                {f.kind === 'bool' && (
                  <div className="segmented" role="radiogroup" aria-labelledby={`survey-${f.key}-label`}>
                    <button type="button" className={values[f.key] === true ? 'on' : ''}
                            onClick={() => set(f.key, true)}>Yes</button>
                    <button type="button" className={values[f.key] === false ? 'on' : ''}
                            onClick={() => set(f.key, false)}>No</button>
                  </div>
                )}
                {f.kind === 'int' && (
                  <input id={`survey-${f.key}`} type="number"
                         value={typeof values[f.key] === 'number' ? values[f.key] as number : ''}
                         onChange={(e) => set(f.key, e.target.value === '' ? undefined : Number(e.target.value))} />
                )}
                {f.kind === 'text' && (
                  <input id={`survey-${f.key}`} value={values[f.key] as string ?? ''}
                         onChange={(e) => set(f.key, e.target.value)} />
                )}
                {f.kind === 'textarea' && (
                  <textarea id={`survey-${f.key}`} rows={3} value={values[f.key] as string ?? ''}
                            onChange={(e) => set(f.key, e.target.value)} />
                )}
                {f.kind === 'select' && (
                  <div role="group" aria-labelledby={`survey-${f.key}-label`}>
                    <ComboBox
                      placeholder={`Choose ${f.label.toLowerCase()}…`}
                      value={values[f.key] as string ?? ''}
                      onChange={(v) => set(f.key, v)}
                      options={f.options.map((o) => ({ value: o, label: o }))}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
          {error && <p className="pf-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid" disabled={!ready || saving}
                  onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save & continue'}
          </button>
          <button type="button" className="mini-btn" onClick={onCancel} disabled={saving}>Cancel</button>
          {!ready && remaining > 0 && (
            <span className="page-hint" role="status">
              {remaining === 1 ? '1 answer still needed' : `${remaining} answers still needed`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Saves every field via `PUT /sites/{id}/survey/{field_key}`, in order —
 *  a small helper so `SiteMoveSurveyOptions` can pass a one-line `onSave`
 *  without repeating the loop at each call site. */
export async function saveSurveyValues(
  siteId: string, values: Record<string, FieldValue>,
): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    await putSiteSurveyValue(siteId, key, value);
  }
}
