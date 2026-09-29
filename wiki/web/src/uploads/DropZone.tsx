/** Drop files and folders from the operating system to upload them: a
 *  DropZone wraps an area (a folder view) and shows "Drop to upload to …"
 *  while files are dragged over it; `dropUpload` is the same drop for
 *  other targets (the sidebar tree's folder rows). Drags that aren't files
 *  (the tree's own row moves, selected text) pass through untouched. */
import { useRef, useState, type DragEvent, type ReactNode } from 'react';

import { useToast } from '@portal/lib/notificationsContext';

import { walkDrop } from './folderWalk';
import { enqueueWalked, type DropDestination } from './uploadQueue';

/** Is this drag carrying files from the operating system? */
export function isFileDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/** Uploads what was dropped (folders recreated) into `dest`. Call it from
 *  the drop handler itself — the dropped entries are only readable then. */
export function dropUpload(data: DataTransfer, dest: DropDestination, onError: (message: string) => void): void {
  walkDrop(data)
    .then((walked) => enqueueWalked(walked, dest, onError))
    .catch(() => onError('Couldn\'t read what was dropped. Try again, or use Upload.'));
}

interface Props {
  dest: DropDestination;
  /** Off for people who can't add files here. */
  enabled: boolean;
  className?: string;
  children: ReactNode;
}

export default function DropZone({ dest, enabled, className, children }: Props) {
  const toast = useToast();
  const [over, setOver] = useState(false);
  // dragenter/dragleave fire for every child crossed: count the depth
  const depth = useRef(0);

  const active = (e: DragEvent) => enabled && isFileDrag(e);

  return (
    <div
      className={`wiki-dropzone${over ? ' is-over' : ''}${className ? ` ${className}` : ''}`}
      onDragEnter={(e) => {
        if (!active(e)) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!active(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (!active(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        if (!active(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        dropUpload(e.dataTransfer, dest, toast);
      }}
    >
      {children}
      {over && (
        <div className="wiki-dropzone-overlay" aria-live="polite">
          <div className="wiki-dropzone-card">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
                 strokeLinejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14" /></svg>
            Drop to upload to {dest.label}
          </div>
        </div>
      )}
    </div>
  );
}
