/**
 * Replace… (spec §4.1, §4.11): a new template takes over from the active
 * templates of its family and label type — the older code rows it was
 * rebuilt from, or another parent — so there is never a moment with two
 * active templates for one family and DPI. The candidates come checked;
 * Replace turns the checked ones off (a parent with its children) and this
 * one on (with its current children) in one call. When the swap would
 * still leave a clash (an unchecked row in the way), nothing changes and
 * the dialog names what is in the way.
 */

import { useState } from 'react';

import DataTable from '../DataTable';
import {
  ApiError, replaceLabelTemplates, templateVersionLabel,
  type LabelTemplate, type LabelTemplateTreeNode,
} from '../../lib/api';
import { templateDpiText } from '../../lib/labels';
import { ListDialog } from './TemplateRowDialogs';

function replaceError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'active_conflict') {
    const names = (err.detail as { names?: string[] } | undefined)?.names ?? [];
    return names.length
      ? `Still in the way: ${names.join(', ')}. Check it to turn it off too.`
      : 'Another active template still prints this family, type and DPI.';
  }
  if (err instanceof ApiError && err.code === 'unknown_templates') {
    return 'One of these templates no longer exists. Close and try again.';
  }
  return "Couldn't replace the templates.";
}

export default function ReplaceTemplateModal({ template, candidates, onReplaced, onClose }: {
  /** The template taking over. */
  template: LabelTemplate;
  /** The active top-level templates of its family and type (replaceCandidates). */
  candidates: LabelTemplateTreeNode[];
  onReplaced: (activated: LabelTemplate) => void;
  onClose: () => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(candidates.map((c) => c.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => setChecked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const replace = async () => {
    const ids = candidates.filter((c) => checked.has(c.id)).map((c) => c.id);
    if (!ids.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      onReplaced(await replaceLabelTemplates(template.id, ids));
    } catch (err) {
      setError(replaceError(err));
      setBusy(false);
    }
  };

  const rows = candidates.map((c) => ({
    key: c.id,
    cells: [
      <input type="checkbox" checked={checked.has(c.id)} disabled={busy} aria-label={`Turn off ${c.name}`}
        onChange={() => toggle(c.id)} />,
      <span className="cell-top">{c.name}</span>,
      templateDpiText(c),
      templateVersionLabel(c),
      <span className={`chip ${c.kind === 'code' ? 'c-slate' : 'c-violet'}`}>{c.kind === 'code' ? 'Raw code' : 'Builder'}</span>,
    ],
  }));

  return (
    <ListDialog label="Replace templates" eyebrow={`${template.name} · Replace`}
      title={`Replace with “${template.name}”`} card="lt-replace-card" busy={busy} onClose={onClose}
      hint={<>Turns the checked templates off and <b>{template.name}</b> on, with its DPI versions, in one
        step. They stay in the list, inactive.</>}
      foot={(
        <>
          <button type="button" className="btn-solid" disabled={busy || checked.size === 0}
            onClick={() => void replace()}>
            {busy ? 'Replacing…' : 'Replace'}
          </button>
          <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </>
      )}>
      <DataTable ariaLabel="Templates to turn off" rows={rows} emptyText="No active template of this family and type."
        columns={[
          { key: 'pick', label: '', width: '36px' },
          { key: 'name', label: 'Template' },
          { key: 'dpi', label: 'DPI', mono: true, width: '110px' },
          { key: 'version', label: 'Version', mono: true, width: '80px' },
          { key: 'kind', label: 'Kind', width: '100px' },
        ]} />
    </ListDialog>
  );
}
