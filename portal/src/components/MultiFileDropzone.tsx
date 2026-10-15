/** Drag-and-drop / click-to-browse for SEVERAL files (the MacroPoint
 *  Manual update). Same `imp-dropzone` look as FileDropzone; the chosen
 *  files are listed below the zone (outside the label, so a remove click
 *  never opens the file picker). Controlled: the caller owns `files`. */
import { useRef, useState, type DragEvent } from 'react';

import { mergeFiles } from '../lib/macropoint';
import { formatBytes } from './FileDropzone';

interface Props {
  files: File[];
  onFiles: (files: File[]) => void;
  busy: boolean;
  accept?: string;
  hint?: string;
  /** Files failing this are left out and reported through onRejected. */
  filter?: (f: File) => boolean;
  onRejected?: (names: string[]) => void;
}

export default function MultiFileDropzone({
  files, onFiles, busy, accept, hint = 'One or more files', filter, onRejected,
}: Props) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const add = (list: FileList | File[] | null | undefined) => {
    const incoming = Array.from(list ?? []);
    const ok = filter ? incoming.filter(filter) : incoming;
    const bad = incoming.filter((f) => !ok.includes(f)).map((f) => f.name);
    if (bad.length) onRejected?.(bad);
    if (ok.length) onFiles(mergeFiles(files, ok));
    if (inputRef.current) inputRef.current.value = '';
  };
  const total = files.reduce((n, f) => n + f.size, 0);

  return (
    <div className="imp-multi">
      <label
        className={`imp-dropzone${dragOver ? ' drag' : ''}`}
        onDragOver={(e: DragEvent<HTMLLabelElement>) => { e.preventDefault(); if (!busy) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e: DragEvent<HTMLLabelElement>) => {
          e.preventDefault();
          setDragOver(false);
          if (!busy) add(e.dataTransfer.files);
        }}
      >
        <input ref={inputRef} type="file" accept={accept} multiple disabled={busy}
               className="imp-dropzone-input" onChange={(e) => add(e.target.files)} />
        <div className="imp-dropzone-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 18a4.5 4.5 0 0 1-1.2-8.84A5.5 5.5 0 0 1 16.5 8H17a4 4 0 0 1 1 7.87" />
            <path d="M12 12v7" />
            <path d="M9.5 14.5 12 12l2.5 2.5" />
          </svg>
          <p className="imp-dropzone-title">Drop your files here, or click to browse</p>
          <p className="imp-dropzone-hint">{hint}</p>
        </div>
      </label>
      {files.length > 0 && (
        <div className="imp-file-box">
          <div className="imp-file-summary">
            <span>{files.length} {files.length === 1 ? 'file' : 'files'} · {formatBytes(total)}</span>
            {files.length > 1 && (
              <button type="button" className="mini-btn" disabled={busy} onClick={() => onFiles([])}>
                Clear all
              </button>
            )}
          </div>
          <ul className="imp-file-list">
            {files.map((f) => (
              <li key={`${f.name}|${f.size}|${f.lastModified}`}>
                <span className="imp-dropzone-file-name">{f.name}</span>
                <span className="imp-dropzone-file-size">{formatBytes(f.size)}</span>
                <button type="button" className="imp-dropzone-remove" disabled={busy}
                        aria-label={`Remove ${f.name}`}
                        onClick={() => onFiles(files.filter((x) => x !== f))}>×</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
