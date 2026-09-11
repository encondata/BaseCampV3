/**
 * Edit a report definition. Move Report keeps its name/description +
 * default sections. Site & Move Survey additionally gets a company-name
 * text field (the `customer.company` context value) and a **Files**
 * section listing every attachment on the definition — both the
 * `survey_template` xlsx (the questionnaire a run fills; several may
 * exist, the newest wins) and the `report_asset` docx (in practice, the
 * Transportation Standards document).
 */
import { useEffect, useRef, useState } from 'react';

import {
  ApiError, deleteAttachment, listAttachments, updateReportDefinition,
  uploadAttachmentRequest, type AttachmentOut,
} from '../../lib/api';
import type { ReportDefinition } from '../../lib/api';
import { MOVE_REPORT_SECTIONS } from '../../lib/reports';
import { Switch } from '../Switch';

/** Files section kind chip — the raw attachment `kind` isn't UI copy. */
const FILE_KIND_LABEL: Record<string, string> = {
  survey_template: 'Survey template', report_asset: 'Document',
};

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
  const isScanHistory = definition.report_type === 'move_scan_history';
  const [name, setName] = useState(definition.name);
  const [description, setDescription] = useState(definition.description);
  const [companyName, setCompanyName] = useState(String(definition.options.company_name ?? ''));
  // Only the switch keys for this report_type — `definition.options` also
  // carries `company_name` (a string) for the survey type, which must
  // never end up coerced into this boolean map (it would overwrite the
  // real company_name with `true`/`false` on save).
  const [boolOptions, setBoolOptions] = useState<Record<string, boolean>>(() => {
    if (isScanHistory) return {};
    const keys = isSurvey ? SURVEY_SWITCHES.map((s) => s.key) : MOVE_REPORT_SECTIONS.map((s) => s.key);
    const out: Record<string, boolean> = {};
    for (const k of keys) out[k] = !!definition.options[k];
    return out;
  });
  // Move Scan History's two string options — a `.segmented` pair each,
  // patched as `{ default_format, status_columns }` (see
  // EditDefinitionModal.test.tsx and the design spec's "Portal" section).
  const [defaultFormat, setDefaultFormat] = useState<'xlsx' | 'pdf'>(
    () => (definition.options.default_format === 'pdf' ? 'pdf' : 'xlsx'));
  const [statusColumns, setStatusColumns] = useState<'pipeline' | 'all'>(
    () => (definition.options.status_columns === 'all' ? 'all' : 'pipeline'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [files, setFiles] = useState<AttachmentOut[]>([]);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState('');
  const [uploadKind, setUploadKind] = useState<'survey_template' | 'report_asset'>('survey_template');
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
        : isScanHistory
        ? { default_format: defaultFormat, status_columns: statusColumns }
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
        entityType: 'report_definition', entityId: definition.id, kind: uploadKind, file,
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

          {isScanHistory && (
            <>
              <div className="modal-section">Default format</div>
              <div className="segmented" role="tablist" aria-label="Default format">
                <button type="button" role="tab" aria-selected={defaultFormat === 'xlsx'}
                        className={defaultFormat === 'xlsx' ? 'on' : ''}
                        onClick={() => setDefaultFormat('xlsx')}>Excel</button>
                <button type="button" role="tab" aria-selected={defaultFormat === 'pdf'}
                        className={defaultFormat === 'pdf' ? 'on' : ''}
                        onClick={() => setDefaultFormat('pdf')}>PDF</button>
              </div>
              <div className="modal-section">Status columns</div>
              <div className="segmented" role="tablist" aria-label="Status columns">
                <button type="button" role="tab" aria-selected={statusColumns === 'pipeline'}
                        className={statusColumns === 'pipeline' ? 'on' : ''}
                        onClick={() => setStatusColumns('pipeline')}>Pipeline</button>
                <button type="button" role="tab" aria-selected={statusColumns === 'all'}
                        className={statusColumns === 'all' ? 'on' : ''}
                        onClick={() => setStatusColumns('all')}>All statuses</button>
              </div>
            </>
          )}

          {!isScanHistory && (
            <>
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
            </>
          )}

          {isSurvey && (
            <>
              <div className="modal-section">Files</div>
              <ul className="mini-list nf-list">
                {filesLoaded && files.length === 0 && (
                  <li className="page-hint">
                    No files yet. Upload the survey template (xlsx) this report fills, and the
                    Transportation Standards document.
                  </li>
                )}
                {files.map((f) => (
                  <li key={f.id} className="mini-row nf-item">
                    <p className="nf-body">
                      {f.url
                        ? <a href={f.url} target="_blank" rel="noreferrer">📎 {f.filename}</a>
                        : <>📎 {f.filename}</>}
                      <span className="chip tag" style={{ marginLeft: 8 }}>
                        {FILE_KIND_LABEL[f.kind] ?? f.kind}</span>
                    </p>
                    <div className="nf-meta">
                      <span className="mono">{(f.size_bytes / 1024).toFixed(0)} KB</span>
                      {f.url && (
                        <a className="mini-btn" href={f.url} target="_blank" rel="noreferrer"
                           aria-label={`Download ${f.filename}`}>Download</a>
                      )}
                      <button className="mini-btn danger" disabled={fileBusy}
                              onClick={() => void removeFile(f.id)}>Delete</button>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="page-hint">The newest survey template is the one a run fills.</p>
              <div className="segmented" role="tablist" aria-label="Upload type" style={{ marginBottom: 8 }}>
                <button type="button" role="tab" aria-selected={uploadKind === 'survey_template'}
                        className={uploadKind === 'survey_template' ? 'on' : ''}
                        onClick={() => setUploadKind('survey_template')}>Survey template</button>
                <button type="button" role="tab" aria-selected={uploadKind === 'report_asset'}
                        className={uploadKind === 'report_asset' ? 'on' : ''}
                        onClick={() => setUploadKind('report_asset')}>Document</button>
              </div>
              <button type="button" className="mini-btn" disabled={fileBusy}
                      onClick={() => fileRef.current?.click()}>
                Upload file
              </button>
              <input ref={fileRef} type="file" hidden
                     accept={uploadKind === 'survey_template' ? '.xlsx' : '.docx,.pdf'}
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
