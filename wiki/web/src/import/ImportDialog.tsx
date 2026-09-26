/** Import: pick `.docx`, `.md`/`.markdown` or `.txt` files and each becomes
 *  a page in the folder, as an unpublished draft. Per file: the page is
 *  created first (a Word document's images are uploaded as its assets),
 *  the file is converted (`importers.ts`, loaded on first use), the page
 *  takes the document's heading 1 as its title, and the content is saved
 *  with `putDraft` (an `imported` version). A file that fails takes its
 *  new page back to the trash. One imported file opens in edit mode;
 *  several stay listed here with their outcome. */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ApiError } from '@portal/lib/api';

import { putUpload } from '../lib/putUpload';
import { noteChanged, noteCreated, noteDeleted } from '../lib/treeStore';
import type { AssetOut, NodeOut } from '../lib/types';
import {
  completeUpload, createNode, deleteNode, errorMessage, putDraft, startUpload, updateNode,
} from '../lib/wikiApi';
import { formatSize } from '../pages/FolderView';

/** What the picker offers (importers.ts `importKind` has the final say). */
const ACCEPT = '.docx,.md,.markdown,.txt';

type Status = 'ready' | 'creating' | 'converting' | 'saving' | 'done' | 'error';

interface Entry {
  file: File;
  status: Status;
  message?: string;
  warnings?: string[];
  nodeId?: string;
}

const STATUS_TEXT: Record<Exclude<Status, 'error'>, string> = {
  ready: 'Ready',
  creating: 'Creating the page…',
  converting: 'Converting…',
  saving: 'Saving…',
  done: 'Imported',
};

interface Props {
  spaceId: string;
  /** null = the space's top level */
  parentId: string | null;
  parentTitle: string;
  onClose: () => void;
}

async function uploadAsset(pageId: string, blob: Blob, name: string): Promise<string> {
  const start = await startUpload({
    target: 'asset', page_id: pageId, filename: name,
    content_type: blob.type || 'application/octet-stream', size: blob.size,
  });
  await putUpload(start.url, start.headers, blob);
  return ((await completeUpload(start.upload_id)) as AssetOut).id;
}

function failureText(err: unknown, name: string): string {
  if (err instanceof ApiError) return errorMessage(err, `Couldn't import “${name}”. Try again.`);
  return `Couldn't read “${name}”. Check that it opens, then try again.`;
}

export default function ImportDialog({ spaceId, parentId, parentTitle, onClose }: Props) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [phase, setPhase] = useState<'picking' | 'running' | 'finished'>('picking');
  const busy = phase === 'running';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) setEntries(files.map((file) => ({ file, status: 'ready' })));
  };

  const run = async () => {
    setPhase('running');
    const set = (i: number, patch: Partial<Entry>) =>
      setEntries((cur) => cur.map((e, j) => (j === i ? { ...e, ...patch } : e)));
    const outcome: Entry[] = entries.map((e) => ({ ...e }));

    try {
      const { baseName, importFile, importKind, unsupportedMessage } = await import('./importers');

      for (let i = 0; i < outcome.length; i += 1) {
        const { file } = outcome[i];
        const finish = (patch: Partial<Entry>) => { Object.assign(outcome[i], patch); set(i, patch); };
        if (!importKind(file.name)) {
          finish({ status: 'error', message: unsupportedMessage(file.name) });
          continue;
        }
        let page: NodeOut | null = null;
        try {
          finish({ status: 'creating' });
          page = await createNode({
            space_id: spaceId, parent_id: parentId, kind: 'page',
            title: baseName(file.name).slice(0, 200).trim() || 'Untitled',
          });
          noteCreated(page);
          finish({ status: 'converting' });
          const pageId = page.id;
          const { title, doc, warnings } = await importFile(file, {
            uploadAsset: (blob, name) => uploadAsset(pageId, blob, name),
          });
          finish({ status: 'saving' });
          // a page that was created and converted is a successful import even
          // if the rename fails — keep it under its filename title rather
          // than trashing good work over a rename
          const allWarnings = [...warnings];
          if (title !== page.title) {
            try {
              noteChanged(await updateNode(page.id, { title }));
            } catch {
              allWarnings.push(`Couldn't rename it to “${title}” — kept “${page.title}”.`);
            }
          }
          await putDraft(page.id, doc);
          finish({ status: 'done', nodeId: page.id, warnings: allWarnings });
        } catch (err) {
          if (page) {
            const made = page;
            await deleteNode(made.id).then(() => noteDeleted(made)).catch(() => {});
          }
          finish({ status: 'error', message: failureText(err, file.name) });
        }
      }
    } catch (err) {
      // the whole run couldn't proceed (e.g. the importers chunk failed to
      // load): every file that hadn't already finished ends in error, not
      // stuck on "Importing…" forever
      outcome.forEach((e, i) => {
        if (e.status === 'done' || e.status === 'error') return;
        const patch: Partial<Entry> = { status: 'error', message: failureText(err, e.file.name) };
        Object.assign(outcome[i], patch);
        set(i, patch);
      });
    } finally {
      setPhase('finished');
    }

    const [only] = outcome;
    if (outcome.length === 1 && only.status === 'done' && !only.warnings?.length) {
      onClose();
      navigate(`/n/${only.nodeId}?edit=1`);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card wiki-dialog-card wiki-import-card" role="dialog"
           aria-modal="true" aria-labelledby="wiki-import-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Wiki</div>
            <h3 id="wiki-import-title">Import pages</h3>
            <p className="page-hint">
              Brings Word (.docx), Markdown (.md) and text (.txt) files into {parentTitle} as pages.
              Each one starts as an unpublished draft.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          {phase === 'picking' && (
            <div className="wiki-import-pick">
              <button type="button" className="btn-ghost" onClick={() => inputRef.current?.click()}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
                     strokeLinejoin="round" aria-hidden="true"><path d="M12 4v12M7 11l5 5 5-5M5 20h14" /></svg>
                {entries.length ? 'Choose other files…' : 'Choose files…'}
              </button>
              <input ref={inputRef} type="file" multiple hidden accept={ACCEPT}
                     aria-label="Choose files to import" onChange={onPick} />
            </div>
          )}
          {entries.length > 0 && (
            <ul className="wiki-import-list" aria-label="Files to import">
              {entries.map((e, i) => (
                // files can share a name, so the position keys them
                <li key={`${i}-${e.file.name}`} className={`wiki-import-item is-${e.status}`} aria-label={e.file.name}>
                  <div className="wiki-import-line">
                    <b title={e.file.name}>{e.file.name}</b>
                    <span className="mono">{formatSize(e.file.size)}</span>
                  </div>
                  <div className="wiki-import-line">
                    <span className={e.status === 'error' ? 'pf-error' : 'wiki-import-status'}>
                      {e.status === 'error' ? e.message : STATUS_TEXT[e.status]}
                    </span>
                    {e.status === 'done' && e.nodeId && (
                      <Link to={`/n/${e.nodeId}?edit=1`} onClick={onClose}>Open</Link>
                    )}
                  </div>
                  {e.warnings?.map((w) => <p key={w} className="wiki-field-note">{w}</p>)}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="modal-foot">
          {phase === 'finished' ? (
            <button className="btn-solid" type="button" onClick={onClose}>Done</button>
          ) : (
            <>
              <button className="btn-solid" type="button" disabled={busy || !entries.length}
                      onClick={() => void run()}>
                {busy ? 'Importing…' : 'Import'}
              </button>
              <button className="mini-btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
