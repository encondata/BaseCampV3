/** The move-assets import's upload fields — the template links, the
 *  dropzone, and the make/model + serial-number options. Shared by the
 *  move import page and the Create-a-move-in-steps assets step. */
import { useState, type DragEvent, type MutableRefObject } from 'react';

import { downloadMoveAssetTemplate } from '../../lib/api';

/** make/model mode descriptions — verbatim intent from the template's
 *  Reference sheet (api/src/serversherpa/imports/parsing.py's
 *  build_template_xlsx), reworded here as a title + one-line description
 *  instead of one cramped all-caps pill label. */
export const MODE_OPTIONS: { value: string; title: string; desc: string }[] = [
  { value: 'fuzzy', title: 'Match only',
    desc: 'Unmatched make/models are flagged for review.' },
  { value: 'force', title: 'Always create',
    desc: 'Missing make/models are created automatically.' },
  { value: 'hybrid', title: 'Match, then create',
    desc: 'Try to match first; create when nothing matches.' },
];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function ImportTemplateLinks({ busy }: { busy: boolean }) {
  return (
    <div className="imp-template-links">
      <span>Download template:</span>
      <button type="button" className="imp-link-btn" disabled={busy}
              onClick={() => void downloadMoveAssetTemplate('xlsx')}>
        .xlsx
      </button>
      <span>·</span>
      <button type="button" className="imp-link-btn" disabled={busy}
              onClick={() => void downloadMoveAssetTemplate('csv')}>
        .csv
      </button>
    </div>
  );
}

interface Props {
  file: File | null;
  onFile: (f: File | null) => void;
  mode: string;
  onMode: (m: string) => void;
  generateSerials: boolean;
  onGenerateSerials: (v: boolean) => void;
  busy: boolean;
  inputRef: MutableRefObject<HTMLInputElement | null>;
}

export default function ImportUploadFields({
  file, onFile, mode, onMode, generateSerials, onGenerateSerials, busy, inputRef,
}: Props) {
  const [dragOver, setDragOver] = useState(false);
  // Clears the file-input's DOM value too — a browser won't re-fire
  // onChange for the same path unless the element's value is cleared first.
  const remove = () => { onFile(null); if (inputRef.current) inputRef.current.value = ''; };

  return (
    <>
      <label
        className={`imp-dropzone${dragOver ? ' drag' : ''}${file ? ' has-file' : ''}`}
        onDragOver={(e: DragEvent<HTMLLabelElement>) => {
          e.preventDefault();
          if (!busy) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e: DragEvent<HTMLLabelElement>) => {
          e.preventDefault();
          setDragOver(false);
          if (busy) return;
          const dropped = e.dataTransfer.files?.[0];
          if (dropped) onFile(dropped);
        }}
      >
        <input ref={inputRef} type="file" accept=".csv,.xlsx,.xls"
               disabled={busy} className="imp-dropzone-input"
               onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
        {file ? (
          <div className="imp-dropzone-file">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
            <div className="imp-dropzone-file-meta">
              <span className="imp-dropzone-file-name">{file.name}</span>
              <span className="imp-dropzone-file-size">{formatBytes(file.size)}</span>
            </div>
            <button type="button" className="imp-dropzone-remove"
                    aria-label="Remove file" disabled={busy}
                    onClick={(e) => { e.preventDefault(); remove(); }}>
              ×
            </button>
          </div>
        ) : (
          <div className="imp-dropzone-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 18a4.5 4.5 0 0 1-1.2-8.84A5.5 5.5 0 0 1 16.5 8H17a4 4 0 0 1 1 7.87" />
              <path d="M12 12v7" />
              <path d="M9.5 14.5 12 12l2.5 2.5" />
            </svg>
            <p className="imp-dropzone-title">Drop your file here, or click to browse</p>
            <p className="imp-dropzone-hint">
              CSV or Excel spreadsheet — .csv, .xlsx, or .xls
            </p>
          </div>
        )}
      </label>

      <div className="imp-options">
        <p className="imp-options-label">Options</p>

        <div className="imp-options-group">
          <p className="imp-options-sublabel">Make / model matching</p>
          <p className="imp-options-explainer">
            How makes and models in your file are matched against the catalog.
          </p>
          <div className="imp-radio-group" role="radiogroup"
               aria-label="Make/model handling">
            {MODE_OPTIONS.map((opt) => (
              <label key={opt.value} className="imp-radio">
                <input type="radio" name="make-model-mode" value={opt.value}
                       checked={mode === opt.value} disabled={busy}
                       onChange={() => onMode(opt.value)} />
                <span className="imp-radio-body">
                  <span className="imp-radio-title">{opt.title}</span>
                  <span className="imp-radio-desc">{opt.desc}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="imp-options-group">
          <p className="imp-options-sublabel">Serial numbers</p>
          <label className="imp-checkbox">
            <input type="checkbox" checked={generateSerials} disabled={busy}
                   onChange={(e) => onGenerateSerials(e.target.checked)} />
            <span className="imp-radio-body">
              <span className="imp-radio-title">Generate serial numbers</span>
              <span className="imp-radio-desc">
                Blank serial-number rows get one generated automatically.
              </span>
            </span>
          </label>
        </div>
      </div>
    </>
  );
}
