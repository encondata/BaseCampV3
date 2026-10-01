/** The page ⋯ menu's "Document type…": which kind of document this page is,
 *  printed on the cover of an exported PDF. Five types or None, picked from
 *  a tap-to-pick list (the same radio cards as the template picker); Save
 *  applies the pick. In the modal header pattern, sized to its content. */
import { useEffect, useRef, useState } from 'react';

import { useToast } from '@portal/lib/notificationsContext';

import { noteChanged } from '../lib/treeStore';
import type { NodeOut } from '../lib/types';
import { errorMessage, setNodeDocType } from '../lib/wikiApi';

/** Exactly the strings the API accepts. */
export const DOC_TYPES = [
  'Operating Procedure', 'Work Instruction', 'Guide', 'Policy', 'Reference',
] as const;

export default function DocTypeDialog({ node, onClose }: { node: NodeOut; onClose: () => void }) {
  const toast = useToast();
  const current = node.page?.doc_type ?? null;
  const [value, setValue] = useState<string | null>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // set on every mount, not just the first: StrictMode (dev) mounts, cleans
  // up and mounts again, and a flag only cleared in cleanup would stay false
  const liveRef = useRef(true);
  useEffect(() => {
    liveRef.current = true;
    return () => { liveRef.current = false; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const saved = await setNodeDocType(node.id, value);
      noteChanged(saved);
      toast('Saved.');
      if (liveRef.current) onClose();
    } catch (err) {
      if (liveRef.current) setError(errorMessage(err, 'Couldn\'t save the document type. Try again.'));
    } finally {
      if (liveRef.current) setBusy(false);
    }
  };

  const options: { value: string | null; label: string }[] = [
    ...DOC_TYPES.map((t) => ({ value: t as string, label: t })),
    { value: null, label: 'None' },
  ];

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card wiki-dialog-card wiki-doctype-card" role="dialog"
           aria-modal="true" aria-labelledby="wiki-doctype-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Export</div>
            <h3 id="wiki-doctype-title">Document type</h3>
            <p className="page-hint">Shown on the cover of an exported PDF.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="wiki-doctype-options" role="radiogroup" aria-label="Document type">
            {options.map((o) => (
              <button
                key={o.label}
                type="button"
                role="radio"
                aria-checked={value === o.value}
                disabled={busy}
                className={`wiki-template-card${value === o.value ? ' selected' : ''}`}
                onClick={() => setValue(o.value)}
              >
                <b>{o.label}</b>
              </button>
            ))}
          </div>
          {error && <p className="pf-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid" disabled={busy || value === current} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
