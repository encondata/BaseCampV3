/**
 * WorkerLevelEditModal — edit-only. `level` and `rank` are immutable from
 * the portal: `rank` is unique-constrained and the API rejects unknown
 * fields on this endpoint (extra="forbid"), so reordering levels is out of
 * scope here — both render as plain read-only text.
 */

import { useState, type FormEvent } from 'react';

import { ApiError, updateWorkerLevel, type WorkerLevel } from '../../lib/api';
import {
  workerLevelFormFromValue,
  workerLevelUpdatePayload,
  type WorkerLevelForm,
} from '../../lib/variables';
import TagInput from '../TagInput';

interface Props {
  value: WorkerLevel;
  canChange: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;   // parent refetches
}

// Codes must match what the server actually raises — `level_not_found`, not
// `worker_level_not_found` (api/src/serversherpa/api/routes/workers.py:294).
const WORKER_LEVEL_ERRORS: Record<string, string> = {
  level_not_found: 'That worker level no longer exists.',
  forbidden: 'You do not have permission to change worker levels.',
};

function mapError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (WORKER_LEVEL_ERRORS[err.code] ?? fallback) : 'Network error.';
}

export default function WorkerLevelEditModal({ value, canChange, onClose, onSaved }: Props) {
  const [form, setForm] = useState<WorkerLevelForm>(() => workerLevelFormFromValue(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const locked = saving || !canChange;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const patch = workerLevelUpdatePayload(form, value);
      if (Object.keys(patch).length > 0) {
        await updateWorkerLevel(value.level, patch);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapError(err, 'Could not save — try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>Edit — {form.title || value.level}</h3>
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
                <label>Level</label>
                <p className="pf-static mono">{value.level}</p>
                <p className="set-note" style={{ padding: 0, margin: '6px 0 0' }}>
                  Permanent — set at deploy time.
                </p>
              </div>
              <div>
                <label>Rank</label>
                <p className="pf-static mono">{value.rank}</p>
                <p className="set-note" style={{ padding: 0, margin: '6px 0 0' }}>
                  Unique per level — reordering isn&rsquo;t supported here.
                </p>
              </div>
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
              {saving ? 'Saving…' : 'Save'}
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
