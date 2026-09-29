/** New page / New folder: a title, then `createNode` and straight to the
 *  new node (a page opens in edit mode). A page can start from a template
 *  (Blank first, then builtin, global and the space's own) — picking one
 *  leaves the title optional, since the server defaults it to the
 *  template's name. `startStep: 'template'` (the top bar's "From
 *  template…") opens straight on the picker instead of the title field. */
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import TemplatePicker from './TemplatePicker';
import { noteCreated } from '../lib/treeStore';
import { createNode, errorMessage } from '../lib/wikiApi';

interface Props {
  kind: 'page' | 'folder';
  spaceId: string;
  /** Only used for a page's template picker. */
  spaceKey: string;
  /** null = the space's top level */
  parentId: string | null;
  /** Where it lands, for the description ("Guides", "Operations"). */
  parentTitle: string;
  /** 'template' opens a new page on the template picker instead of the title field. */
  startStep?: 'template';
  onClose: () => void;
}

export default function NewNodeDialog({
  kind, spaceId, spaceKey, parentId, parentTitle, startStep, onClose,
}: Props) {
  const navigate = useNavigate();
  const [step, setStep] = useState<'template' | 'title'>(
    kind === 'page' && startStep === 'template' ? 'template' : 'title',
  );
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const noun = kind === 'page' ? 'page' : 'folder';
  const trimmed = title.trim();
  const tooLong = trimmed.length > 200;
  const titleRequired = !templateId;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if ((titleRequired && !trimmed) || tooLong || busy) return;
    setBusy(true);
    setError('');
    try {
      const node = await createNode({
        space_id: spaceId, parent_id: parentId, kind,
        ...(trimmed ? { title: trimmed } : {}),
        ...(templateId ? { template_id: templateId } : {}),
      });
      noteCreated(node);
      onClose();
      navigate(kind === 'page' ? `/n/${node.id}?edit=1` : `/n/${node.id}`);
    } catch (err) {
      setError(errorMessage(err, `Couldn't create the ${noun}. Try again.`));
      setBusy(false);
    }
  };

  const titleText = step === 'template' ? 'New page — choose a starting point' : `New ${noun}`;
  const description = step === 'template'
    ? `Adds a page to ${parentTitle}.`
    : `Adds a ${noun} to ${parentTitle}.`;

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className={`modal-card reports-modal-card rgm-card wiki-dialog-card${step === 'template' ? ' wiki-dialog-wide' : ''}`}
           role="dialog" aria-modal="true" aria-labelledby="wiki-new-node-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Wiki</div>
            <h3 id="wiki-new-node-title">{titleText}</h3>
            <p className="page-hint">{description}</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        {step === 'template' ? (
          <>
            <div className="modal-body">
              <TemplatePicker spaceKey={spaceKey} value={templateId} onChange={setTemplateId} />
            </div>
            <div className="modal-foot">
              <button className="btn-solid" type="button" onClick={() => setStep('title')}>Continue</button>
              <button className="mini-btn" type="button" onClick={onClose}>Cancel</button>
            </div>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <div className="modal-body">
              <div className="pf-form">
                <div className="full">
                  <label htmlFor="wiki-new-node-name">Title</label>
                  <input id="wiki-new-node-name" value={title} disabled={busy} autoFocus maxLength={220}
                         placeholder={titleRequired ? (kind === 'page' ? 'Untitled page' : 'Untitled folder') : 'Uses the template\'s name if left blank'}
                         onChange={(e) => setTitle(e.target.value)} />
                </div>
              </div>
              {tooLong && <p className="pf-error">Titles can be up to 200 characters.</p>}
              {error && <p className="pf-error">{error}</p>}
              {kind === 'page' && (
                <button type="button" className="mini-btn wiki-new-node-template-link"
                        onClick={() => setStep('template')} disabled={busy}>
                  {templateId ? 'Change starting point…' : 'Start from a template…'}
                </button>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn-solid" type="submit" disabled={busy || (titleRequired && !trimmed) || tooLong}>
                {busy ? 'Creating…' : `Create ${noun}`}
              </button>
              <button className="mini-btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
