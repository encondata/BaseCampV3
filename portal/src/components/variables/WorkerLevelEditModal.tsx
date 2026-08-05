/**
 * WorkerLevelEditModal — create/edit for a single worker_levels row.
 * `value === null` opens the modal in create mode; once createWorkerLevel
 * succeeds the modal flips itself to edit mode for the created record (the
 * needsWorkerLevelCreate trap in lib/variables.ts) so a retry after a later
 * failure never re-creates the row. Mirrors StatusEditModal.tsx.
 *
 * `level` is an FK target (worker_profiles.level) — free text in create
 * mode, immutable text after. `rank` is NEVER sent or editable from here:
 * the server derives it from `after` (a position, not a number), so create
 * mode offers a Position picker over insertionPoints(levels) instead — "an
 * option for insert between, before or after" collapsed into one gap list —
 * with a live preview of the resulting order built from rankAfter. The
 * preview is where the key-naming consequence becomes visible before saving,
 * not a place to police what keys are allowed.
 */

import { useState, type FormEvent } from 'react';

import { ApiError, createWorkerLevel, updateWorkerLevel, type WorkerLevel } from '../../lib/api';
import {
  PRESET_COLORS,
  insertionPoints,
  needsWorkerLevelCreate,
  previewOrder,
  workerLevelCreatePayload,
  workerLevelFormFromValue,
  workerLevelUpdatePayload,
  type WorkerLevelForm,
} from '../../lib/variables';
import ColorField from './ColorField';
import TagInput from '../TagInput';

interface Props {
  value: WorkerLevel | null;   // null = create mode
  levels: WorkerLevel[];       // the full current scale — insertion points + preview
  canChange: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
}

// Codes must match what the server actually raises — `level_not_found`, not
// `worker_level_not_found` (api/src/serversherpa/api/routes/workers.py:294).
const WORKER_LEVEL_ERRORS: Record<string, string> = {
  level_not_found: 'That worker level no longer exists.',
  worker_level_exists: 'That level key already exists.',
  unknown_level: 'That position no longer exists — reopen and try again.',
  forbidden: 'You do not have permission to change worker levels.',
};

function mapError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (WORKER_LEVEL_ERRORS[err.code] ?? fallback) : 'Network error.';
}

function emptyForm(levels: WorkerLevel[]): WorkerLevelForm {
  const points = insertionPoints(levels);
  return {
    level: '', after: points[points.length - 1].after,   // default to last
    title: '', description: '', expected_skills: [],
    color: PRESET_COLORS[0].value,
  };
}

export default function WorkerLevelEditModal({
  value, levels, canChange, onClose, onSaved,
}: Props) {
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [createdValue, setCreatedValue] = useState<WorkerLevel | null>(null);
  // non-null once a record exists to edit — either passed in, or created
  // earlier in this modal session.
  const original = value ?? createdValue;

  const [form, setForm] = useState<WorkerLevelForm>(
    () => (value ? workerLevelFormFromValue(value) : emptyForm(levels)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isCreate = needsWorkerLevelCreate(value, createdKey);
  const locked = saving || (!isCreate && !canChange);

  const points = insertionPoints(levels);
  const preview = isCreate && form.level.trim() !== ''
    ? previewOrder(levels, form.level, form.after)
    : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (needsWorkerLevelCreate(value, createdKey)) {
        const created = await createWorkerLevel(workerLevelCreatePayload(form));
        // Store immediately — before anything else (onSaved's refetch) can
        // fail — so a retry after a later failure PATCHes instead of
        // re-creating.
        setCreatedKey(created.level);
        setCreatedValue(created);
        await onSaved();
        onClose();
        return;
      }

      const target = original as WorkerLevel;
      const patch = workerLevelUpdatePayload(form, target);
      if (Object.keys(patch).length > 0) {
        await updateWorkerLevel(target.level, patch);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapError(err, 'Could not save — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const title = original ? `Edit — ${form.title || original.level}` : 'New worker level';

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            <div className="modal-section">Details</div>
            <div className="pf-form">
              <div>
                <label>Level *</label>
                {original ? (
                  <>
                    <p className="pf-static mono">{original.level}</p>
                    <p className="set-note" style={{ padding: 0, margin: '6px 0 0' }}>
                      Permanent — can&rsquo;t be changed once created.
                    </p>
                  </>
                ) : (
                  <input value={form.level} required disabled={locked}
                         onChange={(e) => setForm((f) => ({ ...f, level: e.target.value }))} />
                )}
              </div>

              {original ? (
                <div>
                  <label>Rank</label>
                  <p className="pf-static mono">{original.rank}</p>
                  <p className="set-note" style={{ padding: 0, margin: '6px 0 0' }}>
                    Unique per level — reordering isn&rsquo;t supported here.
                  </p>
                </div>
              ) : (
                <div>
                  <label>Position *</label>
                  <select className="org-select" value={form.after ?? ''} disabled={locked}
                          onChange={(e) => setForm((f) => ({
                            ...f, after: e.target.value === '' ? null : e.target.value,
                          }))}>
                    {points.map((p) => (
                      <option key={p.after ?? '__first__'} value={p.after ?? ''}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {isCreate && (
                <div className="full">
                  <label>Resulting order</label>
                  {preview ? (
                    <div className="chips">
                      {/* Keyed by index, not level: the whole point of this
                          preview is to surface a colliding key (typing an
                          existing level) before saving, and duplicate keys
                          would collide as React keys too. */}
                      {preview.map((lvl, i) => (
                        <span key={i} className={`chip ${lvl === form.level ? 'c-amber' : 'tag'}`}>
                          {lvl}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="set-note" style={{ padding: 0 }}>
                      Enter a level key to preview where it lands.
                    </p>
                  )}
                </div>
              )}

              <div className="full">
                <label>Title *</label>
                <input value={form.title} required disabled={locked}
                       onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
              </div>
              <div className="full">
                <label>Description</label>
                <textarea value={form.description} disabled={locked} rows={2}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, description: e.target.value }))} />
              </div>
              <div className="full">
                <label>Colour</label>
                <ColorField value={form.color} disabled={locked} shape="badge"
                            sample={form.level.trim() || undefined}
                            onChange={(hex) => setForm((f) => ({ ...f, color: hex }))} />
              </div>
              <div className="full">
                <label>Expected skills</label>
                <TagInput
                  value={form.expected_skills}
                  disabled={locked}
                  placeholder="Add a skill…"
                  onChange={(skills) => setForm((f) => ({ ...f, expected_skills: skills }))}
                />
              </div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : (isCreate ? 'Create level' : 'Save')}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
