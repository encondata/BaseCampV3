/** Edit a report definition's name, description and default sections. */
import { useState } from 'react';

import { Switch } from '../Switch';
import { ApiError, updateReportDefinition } from '../../lib/api';
import type { ReportDefinition } from '../../lib/api';
import { MOVE_REPORT_SECTIONS } from '../../lib/reports';

export default function EditDefinitionModal({ definition, onClose, onSaved }: {
  definition: ReportDefinition;
  onClose: () => void;
  onSaved: (d: ReportDefinition) => void;
}) {
  const [name, setName] = useState(definition.name);
  const [description, setDescription] = useState(definition.description);
  const [options, setOptions] = useState<Record<string, boolean>>({ ...definition.options });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!name.trim()) { setError('Enter a name.'); return; }
    setSaving(true);
    setError('');
    try {
      const d = await updateReportDefinition(definition.id, {
        name: name.trim(), description, options,
      });
      onSaved(d);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'name_in_use'
        ? 'A report with that name already exists.'
        : err instanceof ApiError ? err.message : "Couldn't save.");
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card">
        <div className="modal-head">
          <h3>Edit {definition.name}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="pf-form">
            <div>
              <label htmlFor="rep-def-name">Name</label>
              <input id="rep-def-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label htmlFor="rep-def-desc">Description</label>
              <input id="rep-def-desc" value={description}
                     onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>
          <div className="modal-section">Default sections</div>
          <div className="report-sections">
            {MOVE_REPORT_SECTIONS.map((s) => (
              <label key={s.key} className="report-section-row">
                <Switch checked={!!options[s.key]}
                        onChange={(v) => setOptions((o) => ({ ...o, [s.key]: v }))} />
                <span className="report-section-text">
                  <span className="report-section-title">{s.title}</span>
                  <span className="report-section-desc">{s.description}</span>
                </span>
              </label>
            ))}
          </div>
          {error && <p className="pf-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn-solid" onClick={() => void save()} disabled={saving}>Save</button>
          <button className="mini-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
