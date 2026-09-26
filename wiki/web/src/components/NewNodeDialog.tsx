/** New page / New folder: a title, then `createNode` and straight to the
 *  new node (a page opens in edit mode). */
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { noteCreated } from '../lib/treeStore';
import { createNode, errorMessage } from '../lib/wikiApi';

interface Props {
  kind: 'page' | 'folder';
  spaceId: string;
  /** null = the space's top level */
  parentId: string | null;
  /** Where it lands, for the description ("Guides", "Operations"). */
  parentTitle: string;
  onClose: () => void;
}

export default function NewNodeDialog({ kind, spaceId, parentId, parentTitle, onClose }: Props) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const noun = kind === 'page' ? 'page' : 'folder';
  const trimmed = title.trim();
  const tooLong = trimmed.length > 200;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || tooLong || busy) return;
    setBusy(true);
    setError('');
    try {
      const node = await createNode({ space_id: spaceId, parent_id: parentId, kind, title: trimmed });
      noteCreated(node);
      onClose();
      navigate(kind === 'page' ? `/n/${node.id}?edit=1` : `/n/${node.id}`);
    } catch (err) {
      setError(errorMessage(err, `Couldn't create the ${noun}. Try again.`));
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card wiki-dialog-card" role="dialog"
           aria-modal="true" aria-labelledby="wiki-new-node-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Wiki</div>
            <h3 id="wiki-new-node-title">New {noun}</h3>
            <p className="page-hint">Adds a {noun} to {parentTitle}.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            <div className="pf-form">
              <div className="full">
                <label htmlFor="wiki-new-node-name">Title</label>
                <input id="wiki-new-node-name" value={title} disabled={busy} autoFocus maxLength={220}
                       placeholder={kind === 'page' ? 'Untitled page' : 'Untitled folder'}
                       onChange={(e) => setTitle(e.target.value)} />
              </div>
            </div>
            {tooLong && <p className="pf-error">Titles can be up to 200 characters.</p>}
            {error && <p className="pf-error">{error}</p>}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={busy || !trimmed || tooLong}>
              {busy ? 'Creating…' : `Create ${noun}`}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
