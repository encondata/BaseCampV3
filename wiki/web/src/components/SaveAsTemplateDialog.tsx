/** The page ⋯ menu's "Save as template…": name, description and icon, plus
 *  where it lands — the space (needs manage there) or global (wiki admins
 *  only). Copies the page's current content via `from_node_id`. */
import { useState, type FormEvent } from 'react';

import { useToast } from '@portal/lib/notificationsContext';

import { atLeast } from './RowMenu';
import type { NodeDetailOut } from '../lib/types';
import { useWikiMe } from '../lib/useWikiMe';
import { createTemplate, errorMessage } from '../lib/wikiApi';

type Scope = 'space' | 'global';

export default function SaveAsTemplateDialog({ node, onClose }: { node: NodeDetailOut; onClose: () => void }) {
  const toast = useToast();
  const me = useWikiMe();
  const canSpace = atLeast(node.space.my_level, 'manage');
  const canGlobal = !!me?.is_admin;
  const [name, setName] = useState(node.title);
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [scope, setScope] = useState<Scope>(canSpace ? 'space' : 'global');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const trimmed = name.trim();
  const tooLong = trimmed.length > 200;
  const noScope = !canSpace && !canGlobal;
  const canSave = !!trimmed && !tooLong && !noScope && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError('');
    try {
      await createTemplate({
        space_id: scope === 'space' ? node.space_id : null,
        name: trimmed,
        description: description.trim() || undefined,
        icon: icon.trim() || undefined,
        from_node_id: node.id,
      });
      toast(`Saved “${trimmed}” as a template.`);
      onClose();
    } catch (err) {
      setError(errorMessage(err, 'Couldn\'t save this as a template. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card wiki-dialog-card" role="dialog"
           aria-modal="true" aria-labelledby="wiki-save-template-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Templates</div>
            <h3 id="wiki-save-template-title">Save as template</h3>
            <p className="page-hint">Makes “{node.title}” a starting point other pages can pick.</p>
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
                <label htmlFor="wiki-st-name">Name</label>
                <input id="wiki-st-name" value={name} disabled={busy} autoFocus maxLength={220}
                       onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="full">
                <label htmlFor="wiki-st-desc">Description</label>
                <input id="wiki-st-desc" value={description} disabled={busy} placeholder="What this is for"
                       onChange={(e) => setDescription(e.target.value)} />
              </div>
              <div>
                <label htmlFor="wiki-st-icon">Icon</label>
                <input id="wiki-st-icon" value={icon} disabled={busy} placeholder="📋" maxLength={8}
                       onChange={(e) => setIcon(e.target.value)} />
              </div>
            </div>
            <div className="modal-section">Where it shows up</div>
            {noScope ? (
              <p className="page-hint">
                You need manage rights on this space, or to be a wiki administrator, to save a template.
              </p>
            ) : (
              <div className="segmented wiki-template-scope" role="group" aria-label="Scope">
                <button type="button" className={scope === 'space' ? 'on' : undefined} aria-pressed={scope === 'space'}
                        disabled={busy || !canSpace} title={canSpace ? undefined : 'You need manage rights on this space'}
                        onClick={() => setScope('space')}>
                  This space
                </button>
                <button type="button" className={scope === 'global' ? 'on' : undefined} aria-pressed={scope === 'global'}
                        disabled={busy || !canGlobal} title={canGlobal ? undefined : 'Only wiki administrators can add global templates'}
                        onClick={() => setScope('global')}>
                  Global
                </button>
              </div>
            )}
            {tooLong && <p className="pf-error">Names can be up to 200 characters.</p>}
            {error && <p className="pf-error">{error}</p>}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={!canSave}>
              {busy ? 'Saving…' : 'Save as template'}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
