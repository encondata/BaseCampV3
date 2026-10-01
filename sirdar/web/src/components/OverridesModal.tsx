import { useEffect, useState } from 'react';

import MatrixTable from '@portal/components/access/MatrixTable';
import { ACTIONS, type Action } from '@portal/lib/access';
import type { AccessResourceOut } from '@portal/lib/api';

import { errorText, getOverrides, putOverrides } from '../lib/sirdarApi';

type Board = Record<string, Partial<Record<Action, boolean>>>;

function sameBoard(a: Board, b: Board): boolean {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const id of ids) {
    for (const act of ACTIONS) if (a[id]?.[act] !== b[id]?.[act]) return false;
  }
  return true;
}

export default function OverridesModal({ personId, name, resources, inherited, onClose, onSaved }: {
  personId: string; name: string; resources: AccessResourceOut[];
  inherited: Record<string, Record<Action, boolean>>;
  onClose: () => void; onSaved: () => void;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [loaded, setLoaded] = useState<Board | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getOverrides(personId).then((r) => { setBoard(r.overrides); setLoaded(r.overrides); })
      .catch((e) => setError(errorText(e, "Couldn't load overrides.")));
  }, [personId]);

  const cycle = (res: string, action: Action) => setBoard((b) => {
    const cur = b?.[res]?.[action];
    const next = cur === undefined ? true : cur === true ? false : undefined;
    const row = { ...(b?.[res] ?? {}) };
    if (next === undefined) delete row[action]; else row[action] = next;
    return { ...(b ?? {}), [res]: row };
  });

  const save = async () => {
    if (!board) return;
    setSaving(true);
    setError('');
    const full: Record<string, Record<Action, boolean | null>> = {};
    for (const r of resources) {
      full[r.id] = Object.fromEntries(ACTIONS.map((a) => [a, board[r.id]?.[a] ?? null])) as Record<Action, boolean | null>;
    }
    try {
      await putOverrides(personId, full);
      onSaved();
    } catch (e) {
      setError(errorText(e, "Couldn't save overrides."));
      setSaving(false);
    }
  };

  const dirty = board !== null && loaded !== null && !sameBoard(board, loaded);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [saving, onClose]);

  const locked = new Set(resources.filter((r) => r.developer_only).map((r) => r.id));

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving && !dirty) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card sirdar-import-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-overrides-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Permission overrides</div>
            <h3 id="sirdar-overrides-title">{name}</h3>
            <p className="page-hint">Click a cell to cycle inherit → allow → deny. Overrides win over roles.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          {error && <p className="form-error" role="alert">{error}</p>}
          {board && (
            <MatrixTable mode="override" resources={resources} overrides={board} inherited={inherited}
                         editable={!saving} lockedResources={locked} onCycle={cycle} />
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn-solid" onClick={save} disabled={saving || !board}>
            {saving ? 'Saving…' : 'Save overrides'}
          </button>
        </div>
      </div>
    </div>
  );
}
