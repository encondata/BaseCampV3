/** A file: breadcrumbs, its title (renamed inline by editors), Download
 *  and Upload new version, a description (saved on blur), a preview by
 *  kind, and its versions (download any, restore an older one).
 *
 *  Previews: images, video and audio in their own elements; a PDF in the
 *  browser's viewer (an iframe of the inline URL); text fetched (at most
 *  MAX_TEXT_PREVIEW) into a <pre>, Markdown rendered through the wiki's
 *  schema (`markdownToDoc` → ReadOnlyDoc — never as raw HTML); office
 *  documents through the worker's PDF, polling every PREVIEW_POLL_MS while
 *  it's being prepared. The API serves inline only what's safe to show
 *  (anything else comes back as an attachment), so only those kinds are
 *  ever put in an iframe or element. */
import type { JSONContent } from '@tiptap/core';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';

import { relativeTime } from '@portal/lib/format';
import { useToast } from '@portal/lib/notificationsContext';

import NodeIcon, { nodeTypeLabel } from '../components/NodeIcon';
import RowMenu, { atLeast } from '../components/RowMenu';
import ReadOnlyDoc from '../editor/ReadOnlyDoc';
import { markdownToDoc } from '../import/importers';
import { openDownload } from '../lib/download';
import { noteChanged } from '../lib/treeStore';
import type { FileVersionOut, NodeDetailOut } from '../lib/types';
import { errorMessage, getFileUrl, listFileVersions, restoreFileVersion, updateFile } from '../lib/wikiApi';
import { enqueue } from '../uploads/uploadQueue';
import { Breadcrumbs, formatSize, InlineTitle } from './FolderView';

export const MAX_TEXT_PREVIEW = 2 * 1024 * 1024;
export const PREVIEW_POLL_MS = 3000;

const NO_PREVIEW = 'No preview — download to open';

type PreviewMode = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'markdown' | 'office' | 'none';

function isMarkdown(v: FileVersionOut): boolean {
  return /\.(md|markdown)$/i.test(v.filename) || v.content_type.toLowerCase().startsWith('text/markdown');
}

function previewMode(v: FileVersionOut | null): PreviewMode {
  if (!v) return 'none';
  if (v.preview_kind === 'pdf') return 'office';
  if (v.preview_kind !== 'native') return 'none';
  const ct = v.content_type.toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct === 'application/pdf') return 'pdf';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  return isMarkdown(v) ? 'markdown' : 'text';
}

type Loaded =
  | { status: 'loading' }
  | { status: 'pending' }
  | { status: 'none'; message: string }
  | { status: 'url'; url: string }
  | { status: 'text'; text: string }
  | { status: 'doc'; doc: JSONContent };

function useLoadedPreview(node: NodeDetailOut, version: FileVersionOut | null, mode: PreviewMode): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const versionId = version?.id;
  const size = version?.size_bytes ?? 0;

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const set = (next: Loaded) => { if (live) setLoaded(next); };
    const failed = () => set({ status: 'none', message: NO_PREVIEW });
    setLoaded({ status: 'loading' });

    if (mode === 'none') {
      set({ status: 'none', message: NO_PREVIEW });
    } else if (mode === 'office') {
      const poll = () => {
        getFileUrl(node.id, { preview: true })
          .then((r) => {
            if (!live) return;
            if (r.url) set({ status: 'url', url: r.url });
            else if (r.preview_status === 'pending') {
              set({ status: 'pending' });
              timer = setTimeout(poll, PREVIEW_POLL_MS);
            } else failed();
          })
          .catch(failed);
      };
      poll();
    } else if ((mode === 'text' || mode === 'markdown') && size > MAX_TEXT_PREVIEW) {
      set({ status: 'none', message: 'This file is too large to preview — download to open.' });
    } else {
      getFileUrl(node.id, { disposition: 'inline' })
        .then(async (r) => {
          if (!r.url) return failed();
          if (mode !== 'text' && mode !== 'markdown') return set({ status: 'url', url: r.url });
          const resp = await fetch(r.url, { credentials: 'omit' });
          if (!resp.ok) return failed();
          const text = await resp.text();
          if (mode === 'markdown') set({ status: 'doc', doc: markdownToDoc(text) });
          else set({ status: 'text', text });
        })
        .catch(failed);
    }
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [node.id, versionId, mode, size]);

  return loaded;
}

function Preview({ node, version }: { node: NodeDetailOut; version: FileVersionOut | null }) {
  const mode = previewMode(version);
  const loaded = useLoadedPreview(node, version, mode);
  const name = version?.filename ?? node.title;

  let body;
  if (loaded.status === 'loading') body = <p className="page-hint">Loading preview…</p>;
  else if (loaded.status === 'pending') body = <p className="page-hint">Preparing preview…</p>;
  else if (loaded.status === 'none') {
    body = (
      <div className="wiki-fileview-empty">
        <NodeIcon node={node} className="wiki-fileview-empty-icon" />
        <p>{loaded.message}</p>
      </div>
    );
  } else if (loaded.status === 'text') body = <pre className="wiki-fileview-text">{loaded.text}</pre>;
  else if (loaded.status === 'doc') body = <ReadOnlyDoc content={loaded.doc} className="wiki-doc wiki-fileview-md" />;
  else if (mode === 'image') body = <img className="wiki-fileview-img" src={loaded.url} alt={name} />;
  else if (mode === 'video') body = <video className="wiki-fileview-media" src={loaded.url} controls preload="metadata" />;
  else if (mode === 'audio') body = <audio src={loaded.url} controls preload="metadata" />;
  else body = <iframe className="wiki-fileview-frame" src={loaded.url} title={`Preview of ${name}`} />;

  return <section className={`wiki-fileview-preview is-${mode}`} aria-label="Preview">{body}</section>;
}

const VERSION_GRID = {
  gridTemplateColumns:
    'minmax(56px, 0.4fr) minmax(200px, 2.4fr) minmax(80px, 0.8fr) minmax(140px, 1.3fr) minmax(110px, 1fr) minmax(96px, 0.8fr) minmax(88px, 0.8fr)',
};

function Versions({ node, canEdit }: { node: NodeDetailOut; canEdit: boolean }) {
  const toast = useToast();
  const currentId = node.file?.current_version?.id ?? null;
  const [versions, setVersions] = useState<FileVersionOut[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    listFileVersions(node.id)
      .then((v) => { if (live) { setVersions(v); setError(false); } })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [node.id, currentId, reload]);

  const download = async (v: FileVersionOut) => {
    try {
      const { url } = await getFileUrl(node.id, { version_id: v.id, disposition: 'attachment' });
      if (url) openDownload(url);
    } catch (err) {
      toast(errorMessage(err, `Couldn't download version ${v.version_no}.`));
    }
  };

  const restore = async (v: FileVersionOut) => {
    setBusy(v.id);
    try {
      const restored = await restoreFileVersion(node.id, v.id);
      toast(`Restored version ${v.version_no} as version ${restored.version_no}.`);
      setReload((n) => n + 1);
      noteChanged(node);
    } catch (err) {
      toast(errorMessage(err, `Couldn't restore version ${v.version_no}.`));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="wiki-fileview-versions" aria-label="Version history">
      <div className="wiki-section-label">Versions</div>
      <div className="dir-list list-scroll" role="table" aria-label="Versions">
        <div className="list-head" style={VERSION_GRID} role="row">
          {['No.', 'File name', 'Size', 'Uploaded by', 'When'].map((h) => (
            <span key={h} role="columnheader">{h}</span>
          ))}
          <span role="columnheader"><span className="sr-only">Download</span></span>
          <span role="columnheader"><span className="sr-only">Restore</span></span>
        </div>
        {versions?.map((v) => (
          <div key={v.id} className="dir-row" role="row">
            <div className="row-main" style={VERSION_GRID}>
              <div className="cell" role="cell">
                <span className="mono cell-line">{v.version_no}</span>
              </div>
              <div className="cell cell-primary" role="cell">
                <div className="pn">
                  <b title={v.filename}>{v.filename}</b>
                  {v.id === currentId && <span className="chip c-green wiki-fileview-current">Current</span>}
                  {v.note && <span className="cell-sub cell-line">{v.note}</span>}
                </div>
              </div>
              <div className="cell" role="cell"><span className="mono cell-line">{formatSize(v.size_bytes)}</span></div>
              <div className="cell" role="cell"><span className="cell-top cell-line">{v.uploaded_by?.name ?? '—'}</span></div>
              <div className="cell" role="cell">
                <span className="cell-top cell-line" title={new Date(v.created_at).toLocaleString()}>
                  {relativeTime(v.created_at)}
                </span>
              </div>
              <div className="cell" role="cell">
                <button type="button" className="mini-btn" aria-label={`Download version ${v.version_no}`}
                        onClick={() => void download(v)}>Download</button>
              </div>
              <div className="cell" role="cell">
                {canEdit && v.id !== currentId && (
                  <button type="button" className="mini-btn" aria-label={`Restore version ${v.version_no}`}
                          disabled={busy !== null} onClick={() => void restore(v)}>
                    {busy === v.id ? 'Restoring…' : 'Restore'}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
        {!versions && !error && <div className="dir-empty">Loading…</div>}
        {!versions && error && <div className="dir-empty"><b>Couldn't load the versions</b>Refresh to try again.</div>}
      </div>
    </section>
  );
}

function Description({ node, canEdit }: { node: NodeDetailOut; canEdit: boolean }) {
  const toast = useToast();
  const stored = node.file?.description ?? '';
  const [saved, setSaved] = useState(stored);
  const [value, setValue] = useState(stored);

  useEffect(() => { setSaved(stored); setValue(stored); }, [stored]);

  const save = async () => {
    if (value === saved) return;
    const before = saved;
    setSaved(value);
    try {
      noteChanged(await updateFile(node.id, value));
    } catch (err) {
      setSaved(before);
      toast(errorMessage(err, 'Couldn\'t save the description.'));
    }
  };

  if (!canEdit) {
    return stored ? <p className="wiki-fileview-desc">{stored}</p> : null;
  }
  return (
    <div className="pf-form wiki-fileview-desc-form">
      <div className="full">
        <label htmlFor="wiki-file-description">Description</label>
        <textarea id="wiki-file-description" rows={2} value={value} maxLength={5000}
                  placeholder="What is this file? Descriptions are searchable."
                  onChange={(e) => setValue(e.target.value)} onBlur={() => void save()} />
      </div>
    </div>
  );
}

export default function FileView({ node }: { node: NodeDetailOut }) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const canEdit = atLeast(node.my_level, 'edit');
  const current = node.file?.current_version ?? null;

  const downloadCurrent = async () => {
    try {
      const { url } = await getFileUrl(node.id, { disposition: 'attachment' });
      if (url) openDownload(url);
    } catch (err) {
      toast(errorMessage(err, `Couldn't download “${node.title}”.`));
    }
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) enqueue([file], { kind: 'version', nodeId: node.id, label: node.title });
  };

  const meta = [
    nodeTypeLabel(node),
    current ? formatSize(current.size_bytes) : null,
    current ? `Version ${current.version_no}` : null,
    current ? `Uploaded${current.uploaded_by ? ` by ${current.uploaded_by.name}` : ''} ${relativeTime(current.created_at)}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="portal-page wiki-page wiki-page-view wiki-fileview" data-testid="file-view">
      <Breadcrumbs node={node} />
      <header className="wiki-page-head">
        <div className="wiki-page-head-main">
          <InlineTitle node={node} label="File title" />
          <div className="wiki-page-meta"><span>{meta}</span></div>
        </div>
        <div className="wiki-page-actions">
          <button type="button" className="btn-ghost" onClick={() => void downloadCurrent()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
                 strokeLinejoin="round" aria-hidden="true"><path d="M12 4v12M7 11l5 5 5-5M5 20h14" /></svg>
            Download
          </button>
          {canEdit && (
            <>
              <button type="button" className="btn-ghost" onClick={() => inputRef.current?.click()}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
                     strokeLinejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14" /></svg>
                Upload new version
              </button>
              <input ref={inputRef} type="file" hidden aria-label="Upload new version" onChange={onPick} />
            </>
          )}
          <RowMenu node={node} />
        </div>
      </header>

      <Description node={node} canEdit={canEdit} />
      <Preview node={node} version={current} />
      <Versions node={node} canEdit={canEdit} />
    </div>
  );
}
