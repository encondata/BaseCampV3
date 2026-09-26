/** Export… for a page, a folder or a whole space (view level). A page
 *  exports as a PDF, a Word document or Markdown — its published version,
 *  without comments — or, when it has subpages, as a .zip of it and them
 *  (the only choice for a never-published page with subpages).
 *  A folder or a space exports as a .zip mirroring the tree: every page
 *  and file the person can see, pages in the chosen format. Once started,
 *  the dialog follows the export (ExportProgress) through to a Download
 *  button; closing it is fine — a notification links to the same status
 *  at /exports/<id>. In the modal header pattern, sized to its content. */
import { useEffect, useState } from 'react';

import type { ExportIn, ExportPageFormat } from '../lib/types';
import { createExport, errorMessage } from '../lib/wikiApi';
import type { ExportTarget } from '../layout/shellContext';
import ExportProgress from './ExportProgress';

const FORMATS: { value: ExportPageFormat; label: string }[] = [
  { value: 'pdf', label: 'PDF' },
  { value: 'docx', label: 'Word' },
  { value: 'md', label: 'Markdown' },
];

export default function ExportDialog({ target, onClose }: { target: ExportTarget; onClose: () => void }) {
  const node = target.kind === 'node' ? target.node : null;
  const title = node ? node.title : target.kind === 'space' ? target.space.name : '';
  // a never-published page has nothing to export on its own: only its subpages
  const unpublishedPage = node?.kind === 'page' && !node.page?.published_version_id;
  const zipOnly = !node || node.kind === 'folder' || unpublishedPage;
  const [format, setFormat] = useState<ExportPageFormat>('pdf');
  const [withSubpages, setWithSubpages] = useState(unpublishedPage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const zip = zipOnly || withSubpages;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const start = async () => {
    const where = node ? { node_id: node.id } : { space_key: target.kind === 'space' ? target.space.key : '' };
    const body: ExportIn = zip ? { ...where, format: 'zip', zip_format: format } : { ...where, format };
    setBusy(true);
    setError('');
    try {
      setJobId((await createExport(body)).job_id);
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t start the export. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const what = !node ? 'space' : node.kind === 'folder' ? 'folder' : 'page';
  const hint = zip
    ? `A .zip of the ${what === 'page' ? 'page and its subpages' : what} — every page and file in it you can see, in the same folders. Pages that were never published are left out.`
    : 'The published version of the page, without comments.';

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card wiki-dialog-card wiki-export-card" role="dialog"
           aria-modal="true" aria-labelledby="wiki-export-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Export</div>
            <h3 id="wiki-export-title">Export “{title}”</h3>
            <p className="page-hint">Download a copy to read offline or share outside the wiki.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>

        {jobId ? (
          <div className="modal-body wiki-export-body"><ExportProgress jobId={jobId} /></div>
        ) : (
          <div className="modal-body wiki-export-body">
            {node?.kind === 'page' && node.has_children && (
              <>
                <div className="modal-section">What</div>
                <div className="segmented wiki-export-scope" role="group" aria-label="What to export">
                  <button type="button" className={!zip ? 'on' : undefined} aria-pressed={!zip}
                          disabled={busy || unpublishedPage}
                          title={unpublishedPage ? 'Only a published page exports on its own' : undefined}
                          onClick={() => setWithSubpages(false)}>
                    This page
                  </button>
                  <button type="button" className={zip ? 'on' : undefined} aria-pressed={zip}
                          disabled={busy} onClick={() => setWithSubpages(true)}>
                    With subpages (.zip)
                  </button>
                </div>
              </>
            )}
            <div className="modal-section">{zip ? 'Pages as' : 'Format'}</div>
            <div className="segmented wiki-export-format" role="group" aria-label={zip ? 'Pages as' : 'Format'}>
              {FORMATS.map((f) => (
                <button key={f.value} type="button" className={format === f.value ? 'on' : undefined}
                        aria-pressed={format === f.value} disabled={busy} onClick={() => setFormat(f.value)}>
                  {f.label}
                </button>
              ))}
            </div>
            <p className="page-hint">{hint}</p>
            {error && <p className="pf-error">{error}</p>}
          </div>
        )}

        <div className="modal-foot">
          {jobId ? (
            <button type="button" className="mini-btn" onClick={onClose}>Done</button>
          ) : (
            <>
              <button type="button" className="btn-solid" disabled={busy} onClick={() => void start()}>
                {busy ? 'Starting…' : 'Export'}
              </button>
              <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
