/**
 * The builder page's small dialogs, each with the report-generate header
 * and sized to its content:
 *  - CloneModal: Clone to a new template (POST …/clone), inactive.
 *  - OutOfDateModal: after a parent save, each customized DPI the save
 *    passed by (spec §3.4) — Update now makes a fresh child from the parent
 *    and keeps the old one, inactive, as "… Old"; Keep leaves it as it is.
 *  - LeaveModal: leaving with unsaved changes.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { ApiError, cloneLabelTemplate, updateLabelTemplateFromParent, type LabelTemplate } from '../../../lib/api';
import '../../../styles/directory.css';
import '../../../styles/profile.css';   /* .pf-form, .btn-solid, .pf-error */
import '../../../styles/reports.css';
import '../../../styles/labelBuilder.css';

function Dialog({ label, title, hint, card, busy = false, onClose, children, foot }: {
  label: string; title: string; hint: ReactNode; card: string; busy?: boolean; onClose: () => void;
  children?: ReactNode; foot: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className={`modal-card reports-modal-card rgm-card ${card}`} role="dialog" aria-modal="true" aria-label={label}>
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Label builder</div>
            <h3>{title}</h3>
            <p className="page-hint">{hint}</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        {children && <div className="modal-body">{children}</div>}
        <div className="modal-foot">{foot}</div>
      </div>
    </div>
  );
}

export function CloneModal({ template, onCloned, onClose }: {
  template: Pick<LabelTemplate, 'id' | 'name'>;
  onCloned: (copy: LabelTemplate) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(`${template.name} copy`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clone = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      onCloned(await cloneLabelTemplate(template.id, name.trim()));
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'label_template_exists'
        ? 'A template, or one of its DPI versions, already has that name.'
        : "Couldn't clone the template.");
      setBusy(false);
    }
  };
  return (
    <Dialog label="Clone template" title={`Clone ${template.name}`} card="lbb-small-card" busy={busy} onClose={onClose}
      hint="A new template with this design, its samples, sites and DPI versions. It starts inactive."
      foot={(
        <>
          <button type="button" className="btn-solid" disabled={!name.trim() || busy} onClick={() => void clone()}>
            {busy ? 'Cloning…' : 'Clone'}
          </button>
          <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </>
      )}>
      <div className="pf-form">
        <div className="full">
          <label htmlFor="lbb-clone-name">New name</label>
          <input id="lbb-clone-name" value={name} autoFocus autoComplete="off" disabled={busy}
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void clone(); }} />
        </div>
      </div>
    </Dialog>
  );
}

export interface OutOfDateChild {
  id: string;
  name: string;
  /** The child's version (v6.2). */
  version: string;
}

type Choice = 'updating' | 'updated' | 'kept' | 'failed';

export function OutOfDateModal({ parentVersion, items, onDone }: {
  /** The version just saved (v7). */
  parentVersion: string;
  items: OutOfDateChild[];
  /** Closes; `updated` says whether any child was updated. */
  onDone: (updated: boolean) => void;
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const busy = Object.values(choices).includes('updating');
  const updated = Object.values(choices).includes('updated');
  const set = (id: string, choice: Choice) => setChoices((c) => ({ ...c, [id]: choice }));
  const update = async (child: OutOfDateChild) => {
    set(child.id, 'updating');
    try {
      await updateLabelTemplateFromParent(child.id);
      set(child.id, 'updated');
    } catch {
      set(child.id, 'failed');
    }
  };
  const close = () => onDone(updated);
  return (
    <Dialog label="Customized DPIs out of date" title="These DPIs have their own edits" card="lbb-small-card"
      busy={busy} onClose={close}
      hint={<>They kept their edits, so they don&apos;t follow {parentVersion}. Update now makes a fresh one
        from {parentVersion} and keeps the edited one, inactive, as “… Old”.</>}
      foot={<button type="button" className="btn-solid" onClick={close} disabled={busy}>Done</button>}>
      <div className="lbb-stale">
        {items.map((child) => {
          const choice = choices[child.id];
          return (
            <div key={child.id} className="lbb-stale-item">
              <span className="lbb-stale-name"><b>{child.name}</b> <span className="lbp-hint">{child.version}</span></span>
              {choice === 'updated' && <span className="chip c-green">Updated</span>}
              {choice === 'kept' && <span className="chip tag">Kept</span>}
              {choice === 'failed' && <span className="pf-error">Couldn&apos;t update it.</span>}
              {(choice === undefined || choice === 'updating' || choice === 'failed') && (
                <span className="lbb-stale-actions">
                  <button type="button" className="btn-solid" disabled={busy} onClick={() => void update(child)}>
                    {choice === 'updating' ? 'Updating…' : 'Update now'}
                  </button>
                  <button type="button" className="mini-btn" disabled={busy} onClick={() => set(child.id, 'kept')}>Keep</button>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}

export function LeaveModal({ onLeave, onStay }: { onLeave: () => void; onStay: () => void }) {
  return (
    <Dialog label="Unsaved changes" title="Leave without saving?" card="lbb-small-card" onClose={onStay}
      hint="This template has changes that aren't saved. Leaving drops them."
      foot={(
        <>
          <button type="button" className="btn-solid" onClick={onLeave}>Leave without saving</button>
          <button type="button" className="mini-btn" onClick={onStay} autoFocus>Stay</button>
        </>
      )} />
  );
}
