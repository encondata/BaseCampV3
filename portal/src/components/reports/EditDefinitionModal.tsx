/**
 * Edit a report definition. Move Report keeps its name/description +
 * default sections. Site & Move Survey additionally gets a company-name
 * text field (the `customer.company` context value) and a **Files**
 * section for the `report_asset` attachments this report reads from —
 * in practice, the Transportation Standards docx.
 */
import { useEffect, useRef, useState } from 'react';

import {
  ApiError, deleteAttachment, listAttachments, updateReportDefinition,
  uploadAttachmentRequest, type AttachmentOut,
} from '../../lib/api';
import type { ReportDefinition } from '../../lib/api';
import { MOVE_REPORT_SECTIONS } from '../../lib/reports';
import { Switch } from '../Switch';

const SURVEY_SWITCHES: { key: string; title: string; description: string }[] = [
  {
    key: 'include_transportation_standards', title: 'Include Transportation Standards',
    description: 'Default for whether a run appends the Transportation Standards document as a sheet.',
  },
  {
    key: 'include_site_photos', title: 'Include site photos',
    description: "Default for whether a run appends a Site Photos sheet from each site's photos.",
  },
  {
    key: 'condensed_assets', title: 'Condensed assets by default',
    description: 'Default for grouping the equipment list by make and model instead of every asset.',
  },
];

export default function EditDefinitionModal({ definition, onClose, onSaved }: {
  definition: ReportDefinition;
  onClose: () => void;
  onSaved: (d: ReportDefinition) => void;
}) {
  const isSurvey = definition.report_type === 'site_move_survey';
  const [name, setName] = useState(definition.name);
  const [description, setDescription] = useState(definition.description);
  const [companyName, setCompanyName] = useState(String(definition.options.company_name ?? ''));
  // Only the switch keys for this report_type — `definition.options` also
  // carries `company_name` (a string) for the survey type, which must
  // never end up coerced into this boolean map (it would overwrite the
  // real company_name with `true`/`false` on save).
  const [boolOptions, setBoolOptions] = useState<Record<string, boolean>>(() => {
    const keys = isSurvey ? SURVEY_SWITCHES.map((s) => s.key) : MOVE_REPORT_SECTIONS.map((s) => s.key);
    const out: Record<string, boolean> = {};
    for (const k of keys) out[k] = !!definition.options[k];
    return out;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [files, setFiles] = useState<AttachmentOut[]>([]);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isSurvey) return;
    let cancelled = false;
    listAttachments('report_definition', definition.id)
      .then((f) => { if (!cancelled) { setFiles(f); setFilesLoaded(true); } })
      .catch(() => { if (!cancelled) setFilesLoaded(true); });
    return () => { cancelled = true; };
  }, [isSurvey, definition.id]);

  const save = async () => {
    if (!name.trim()) { setError('Enter a name.'); return; }
    setSaving(true);
    setError('');
    try {
      const options = isSurvey
        ? { company_name: companyName.trim(), ...boolOptions }
        : boolOptions;
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

  const uploadFile = async (file: File) => {
    setFileBusy(true);
    setFileError('');
    try {
      const att = await uploadAttachmentRequest({
        entityType: 'report_definition', entityId: definition.id, kind: 'report_asset', file,
      });
      setFiles((f) => [att, ...f]);
    } catch (err) {
      setFileError(err instanceof ApiError ? err.message : 'Upload failed.');
    } finally {
      setFileBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeFile = async (id: string) => {
    setFileBusy(true);
    setFileError('');
    try {
      await deleteAttachment(id);
      setFiles((f) => f.filter((x) => x.id !== id));
    } catch {
      setFileError('Could not delete the file.');
    } finally {
      setFileBusy(false);
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
            {isSurvey && (
              <div>
                <label htmlFor="rep-def-company">Company name</label>
                <input id="rep-def-company" value={companyName}
                       onChange={(e) => setCompanyName(e.target.value)} />
              </div>
            )}
          </div>

          <div className="modal-section">{isSurvey ? 'Default options' : 'Default sections'}</div>
          <div className="mini-list report-sections">
            {(isSurvey ? SURVEY_SWITCHES : MOVE_REPORT_SECTIONS).map((s) => (
              <label key={s.key} className="mini-row report-section-row">
                <Switch checked={!!boolOptions[s.key]}
                        onChange={(v) => setBoolOptions((o) => ({ ...o, [s.key]: v }))} />
                <span className="report-section-text">
                  <span className="cell-top">{s.title}</span>
                  <span className="cell-sub">{s.description}</span>
                </span>
              </label>
            ))}
          </div>

          {isSurvey && (
            <>
              <div className="modal-section">Files</div>
              <ul className="mini-list nf-list">
                {filesLoaded && files.length === 0 && <li className="page-hint">No files yet.</li>}
                {files.map((f) => (
                  <li key={f.id} className="mini-row nf-item">
                    <p className="nf-body">📎 {f.filename}</p>
                    <div className="nf-meta">
                      <span className="mono">{(f.size_bytes / 1024).toFixed(0)} KB</span>
                      <button className="mini-btn danger" disabled={fileBusy}
                              onClick={() => void removeFile(f.id)}>Delete</button>
                    </div>
                  </li>
                ))}
              </ul>
              <button type="button" className="mini-btn" disabled={fileBusy}
                      onClick={() => fileRef.current?.click()}>
                Upload file
              </button>
              <input ref={fileRef} type="file" hidden accept=".docx,.pdf"
                     onChange={(e) => {
                       const f = e.target.files?.[0];
                       if (f) void uploadFile(f);
                     }} />
              {fileError && <p className="pf-error">{fileError}</p>}
            </>
          )}

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
