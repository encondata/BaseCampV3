/** Move… / Copy…: pick a destination in the TreePicker, then `moveNode` or
 *  `copyNode`. A move stays in the node's space unless the mover manages
 *  the node; a copy can go to any space the person can edit in, and opens
 *  the copy when it's made. */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiError } from '@portal/lib/api';
import { useToast } from '@portal/lib/notificationsContext';

import { noteCreated, noteMoved } from '../lib/treeStore';
import type { NodeCopyIn, NodeMoveIn, NodeOut, SpaceOut } from '../lib/types';
import { copyNode, errorMessage, listSpaces, moveNode } from '../lib/wikiApi';
import TreePicker, { type Destination } from './TreePicker';

interface Props {
  node: NodeOut;
  mode: 'move' | 'copy';
  onClose: () => void;
}

function describe(node: NodeOut, mode: 'move' | 'copy'): string {
  if (mode === 'move') {
    return 'Pick where it goes. Only places you can edit can be picked; its permissions follow its new place.';
  }
  if (node.kind === 'folder') return 'Everything inside is copied too. Pages come across as unpublished drafts.';
  if (node.kind === 'page') return 'The copy is a new, unpublished page with the current draft — its history stays here.';
  return 'The copy is a new file with the current version.';
}

function failure(err: unknown, mode: 'move' | 'copy', title: string): string {
  if (err instanceof ApiError && err.code === 'too_many') {
    return errorMessage(err, 'That\'s more than 500 items — too many to copy at once. Copy the folders inside one by one.');
  }
  return errorMessage(err, mode === 'move' ? `Couldn't move “${title}”.` : `Couldn't copy “${title}”.`);
}

export default function MoveCopyDialog({ node, mode, onClose }: Props) {
  const toast = useToast();
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState<SpaceOut[] | null>(null);
  const [dest, setDest] = useState<Destination | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const verb = mode === 'move' ? 'Move' : 'Copy';

  useEffect(() => {
    let live = true;
    listSpaces()
      .then((all) => { if (live) setSpaces(all); })
      .catch((err) => { if (live) { setSpaces([]); setError(errorMessage(err, 'Couldn\'t load the libraries.')); } });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  // moving to another space needs manage on the node
  const shown = useMemo(() => {
    if (!spaces) return null;
    const crossSpace = mode === 'copy' || node.my_level === 'manage';
    const list = crossSpace ? spaces : spaces.filter((s) => s.id === node.space_id);
    // the node's own space first
    return [...list].sort((a, b) => Number(b.id === node.space_id) - Number(a.id === node.space_id));
  }, [spaces, mode, node.my_level, node.space_id]);

  const unchanged = mode === 'move' && !!dest && dest.spaceId === node.space_id && dest.parentId === node.parent_id;

  const submit = async () => {
    if (!dest || unchanged || busy) return;
    setBusy(true);
    setError('');
    const otherSpace = dest.spaceId !== node.space_id ? { space_id: dest.spaceId } : {};
    try {
      if (mode === 'move') {
        const body: NodeMoveIn = { parent_id: dest.parentId, ...otherSpace };
        const moved = await moveNode(node.id, body);
        noteMoved(moved, { spaceKey: node.space_key, parentId: node.parent_id });
        toast(`Moved “${node.title}” to ${dest.title}.`);
        onClose();
      } else {
        const body: NodeCopyIn = { parent_id: dest.parentId, ...otherSpace };
        const copy = await copyNode(node.id, body);
        noteCreated(copy);
        toast(`Copied “${node.title}” to ${dest.title}.`);
        onClose();
        navigate(`/n/${copy.id}`);
      }
    } catch (err) {
      setError(failure(err, mode, node.title));
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card wiki-move-card" role="dialog"
           aria-modal="true" aria-labelledby="wiki-move-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">{verb}</div>
            <h3 id="wiki-move-title">{verb} “{node.title}”</h3>
            <p className="page-hint">{describe(node, mode)}</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="wiki-picker-box">
            {shown ? (
              <TreePicker
                spaces={shown}
                value={dest}
                onChange={(d) => { setDest(d); setError(''); }}
                exclude={node.id}
                current={mode === 'move' ? { spaceId: node.space_id, parentId: node.parent_id } : undefined}
                initiallyOpen={[node.space_id]}
              />
            ) : <p className="page-hint">Loading…</p>}
          </div>
          <p className="wiki-field-note">
            {dest ? `${verb} to ${dest.title}${dest.parentId ? '' : ' (top level)'}.` : 'Nothing picked yet.'}
          </p>
          {error && <p className="pf-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid" disabled={!dest || unchanged || busy} onClick={() => void submit()}>
            {busy ? (mode === 'move' ? 'Moving…' : 'Copying…') : `${verb} here`}
          </button>
          <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
