/** A folder: breadcrumbs, its title (renamed inline by editors), Watch and
 *  Export…, New page / New folder / Upload / Import, and its contents in the portal's list
 *  styling (Name, Type, Updated, By, Size; pages due for review carry a
 *  chip). Editors can also drop files and folders from their computer
 *  anywhere on it (the upload tray takes over). */
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';

import { relativeTime } from '@portal/lib/format';
import { useToast } from '@portal/lib/notificationsContext';

import NewNodeDialog from '../components/NewNodeDialog';
import NodeIcon, { nodeTypeLabel } from '../components/NodeIcon';
import { atLeast } from '../components/RowMenu';
import WatchButton from '../components/WatchButton';
import ImportDialog from '../import/ImportDialog';
import { useWikiShell } from '../layout/shellContext';
import ReviewChip from '../reviews/ReviewChip';
import { libraryPath } from '../lib/paths';
import { noteChanged, useChildren } from '../lib/treeStore';
import type { NodeDetailOut, NodeOut } from '../lib/types';
import { errorMessage, updateNode } from '../lib/wikiApi';
import DropZone from '../uploads/DropZone';
import { enqueue } from '../uploads/uploadQueue';

const GRID = {
  gridTemplateColumns:
    'minmax(240px, 3fr) minmax(110px, 1fr) minmax(100px, 0.9fr) minmax(140px, 1.2fr) minmax(80px, 0.7fr)',
};

/** Bytes as "812 KB" / "2.4 MB" (binary units, one decimal under 10). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function Breadcrumbs({ node }: { node: NodeDetailOut }) {
  return (
    <nav className="wiki-crumbs" aria-label="Breadcrumb">
      <Link to={libraryPath(node.space.key)}>{node.space.name}</Link>
      {node.breadcrumbs.map((c, i) => (
        <span key={c.id ?? `hidden-${i}`} className="wiki-crumb">
          <span className="wiki-crumb-sep" aria-hidden="true">/</span>
          {c.id ? <Link to={`/n/${c.id}`}>{c.title}</Link> : (
            // an ancestor the viewer can't see: never its title, whatever the API sent
            <span title="A folder you don't have access to">…</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** The node's title as a heading; editors rename it in place (pencil,
 *  Enter saves, Escape cancels). */
export function InlineTitle({ node, label = 'Folder title', showIcon = true }: {
  node: NodeDetailOut; label?: string; showIcon?: boolean;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(node.title);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.title);
  const settled = useRef(false);
  const canEdit = atLeast(node.my_level, 'edit');

  useEffect(() => { setTitle(node.title); }, [node.title]);

  const start = () => { settled.current = false; setDraft(title); setEditing(true); };
  const save = async () => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    const next = draft.trim();
    if (!next || next === title) return;
    if (next.length > 200) { toast('Titles can be up to 200 characters.'); return; }
    const before = title;
    setTitle(next);
    try {
      noteChanged(await updateNode(node.id, { title: next }));
    } catch (err) {
      setTitle(before);
      toast(errorMessage(err, `Couldn't rename “${before}”.`));
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); void save(); }
    if (e.key === 'Escape') { e.preventDefault(); settled.current = true; setEditing(false); }
  };

  if (editing) {
    return (
      <input className="wiki-title-input" aria-label={label} value={draft} autoFocus maxLength={220}
             onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={() => void save()}
             onFocus={(e) => e.currentTarget.select()} />
    );
  }
  return (
    <div className="wiki-title-row">
      <h1 className="page-title wiki-title">
        {showIcon && <NodeIcon node={node} className="wiki-title-icon" />}
        <span>{title}</span>
      </h1>
      {canEdit && (
        <button type="button" className="wiki-title-edit" aria-label={`Rename ${title}`} title="Rename"
                onClick={start}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
               strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" /></svg>
        </button>
      )}
    </div>
  );
}

function Row({ node }: { node: NodeOut }) {
  const size = node.file?.current_version?.size_bytes;
  return (
    <div className="dir-row" role="listitem">
      <Link to={`/n/${node.id}`} className="row-main wiki-row-link" style={GRID}>
        <div className="cell cell-primary">
          <NodeIcon node={node} className="wiki-row-icon" />
          <div className="pn"><b title={node.title}>{node.title}</b></div>
          <ReviewChip review={node.review} />
        </div>
        <div className="cell"><span className="cell-top cell-line">{nodeTypeLabel(node)}</span></div>
        <div className="cell">
          <span className="cell-top cell-line" title={new Date(node.updated_at).toLocaleString()}>
            {relativeTime(node.updated_at)}
          </span>
        </div>
        <div className="cell"><span className="cell-top cell-line">{node.updated_by?.name ?? '—'}</span></div>
        <div className="cell"><span className="mono cell-line">{size != null ? formatSize(size) : '—'}</span></div>
      </Link>
    </div>
  );
}

/** A folder's (or a space's) items in the portal's list styling. */
export function ContentsList({ label, nodes, error, empty, emptyTitle }: {
  label: string; nodes: NodeOut[] | null; error: boolean; empty: string; emptyTitle: string;
}) {
  return (
    <div className="dir-list list-scroll wiki-folder-list">
      <div className="list-head" style={GRID} aria-hidden="true">
        <span>Name</span><span>Type</span><span>Updated</span><span>By</span><span>Size</span>
      </div>
      <div role="list" aria-label={label}>
        {nodes?.map((n) => <Row key={n.id} node={n} />)}
      </div>
      {!nodes && !error && <div className="dir-empty">Loading…</div>}
      {!nodes && error && <div className="dir-empty"><b>Couldn't load this list</b>Refresh to try again.</div>}
      {nodes?.length === 0 && <div className="dir-empty"><b>{emptyTitle}</b>{empty}</div>}
    </div>
  );
}

export default function FolderView({ node }: { node: NodeDetailOut }) {
  const { nodes, error } = useChildren(node.space_key, node.id);
  const { requestExport } = useWikiShell();
  const [creating, setCreating] = useState<'page' | 'folder' | null>(null);
  const [importing, setImporting] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const canEdit = atLeast(node.my_level, 'edit');
  const dest = { spaceId: node.space_id, spaceKey: node.space_key, parentId: node.id, label: node.title };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) enqueue(files, { kind: 'node', ...dest });
  };

  return (
    <>
      <DropZone dest={dest} enabled={canEdit} className="wiki-folder-drop">
        <div className="portal-page wiki-page">
          <Breadcrumbs node={node} />
          <div className="dir-head wiki-folder-head">
            <InlineTitle node={node} />
          </div>

          <div className="dir-toolbar">
            <WatchButton target={{ kind: 'node', nodeId: node.id }} />
            <button type="button" className="btn-ghost" onClick={() => requestExport({ kind: 'node', node })}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
                   strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14" /></svg>
              Export…
            </button>
            {canEdit && (
              <div className="toolbar-right wiki-toolbar">
                <button type="button" className="btn-ghost" onClick={() => setCreating('page')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
                       strokeLinejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M12 11v6M9 14h6" /></svg>
                  New page
                </button>
                <button type="button" className="btn-ghost" onClick={() => setCreating('folder')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
                       strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10.5v5M9.5 13h5" /></svg>
                  New folder
                </button>
                <button type="button" className="btn-ghost" title="Upload files (or drop them anywhere here)"
                        onClick={() => uploadRef.current?.click()}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
                       strokeLinejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14" /></svg>
                  Upload
                </button>
                <input ref={uploadRef} type="file" multiple hidden aria-label={`Upload files to ${node.title}`}
                       onChange={onPick} />
                <button type="button" className="btn-ghost" title="Turn Word, Markdown or text files into pages"
                        onClick={() => setImporting(true)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
                       strokeLinejoin="round" aria-hidden="true"><path d="M12 4v12M7 11l5 5 5-5M5 20h14" /></svg>
                  Import
                </button>
              </div>
            )}
          </div>

          <ContentsList label={`Contents of ${node.title}`} nodes={nodes} error={error}
                        empty={canEdit
                          ? 'Add a page or a folder, or drop files here, to get started.'
                          : 'Nothing has been added yet.'}
                        emptyTitle="This folder is empty" />
        </div>
      </DropZone>

      {/* outside the drop zone: a file dropped on a dialog isn't an upload */}
      {creating && (
        <NewNodeDialog kind={creating} spaceId={node.space_id} spaceKey={node.space_key} parentId={node.id}
                       parentTitle={node.title} onClose={() => setCreating(null)} />
      )}
      {importing && (
        <ImportDialog spaceId={node.space_id} parentId={node.id} parentTitle={node.title}
                      onClose={() => setImporting(false)} />
      )}
    </>
  );
}
