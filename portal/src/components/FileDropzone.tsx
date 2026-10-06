/** The drag-and-drop / click-to-browse file zone (imp-dropzone) shared by the
 *  From-To import and Convert Raw F-T. Controlled: the caller owns
 *  `file`; `inputRef` lets it clear the input's DOM value. */
import { useState, type DragEvent, type MutableRefObject } from 'react';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

interface Props {
  file: File | null;
  onFile: (f: File | null) => void;
  busy: boolean;
  inputRef: MutableRefObject<HTMLInputElement | null>;
  accept?: string;
  hint?: string;
}

export default function FileDropzone({
  file, onFile, busy, inputRef, accept = '.csv,.xlsx,.xls',
  hint = 'CSV or Excel spreadsheet — .csv, .xlsx, or .xls',
}: Props) {
  const [dragOver, setDragOver] = useState(false);
  // Clears the file-input's DOM value too — a browser won't re-fire
  // onChange for the same path unless the element's value is cleared first.
  const remove = () => { onFile(null); if (inputRef.current) inputRef.current.value = ''; };

  return (
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
      <input ref={inputRef} type="file" accept={accept}
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
            {hint}
          </p>
        </div>
      )}
    </label>
  );
}
