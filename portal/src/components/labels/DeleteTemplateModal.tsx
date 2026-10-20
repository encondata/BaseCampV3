/**
 * Delete a label template for good (spec §3.4, §4.1, §4.9).
 *
 * A top-level template — a builder parent, or an older single row — lists
 * everything that goes with it: its DPI versions (current and Old) and the
 * count of labels generated from them, which the portal deletes too (they
 * can be generated again). Delete stays off until the template's name is
 * typed exactly, case and spaces included; the API checks it again.
 *
 * A DPI child goes on a plain confirmation: a current one leaves its
 * parent's DPI set (Add DPI brings it back), an Old one just goes.
 */

import { useCallback, useEffect, useState } from 'react';

import DataTable from '../DataTable';
import {
  ApiError, deleteLabelTemplateForGood, getLabelTemplateDeleteSummary, templateVersionLabel,
  type LabelTemplate, type LabelTemplateChild, type LabelTemplateDeleteSummary,
} from '../../lib/api';
import { childStateChips } from '../../lib/labels';
import { ListDialog } from './TemplateRowDialogs';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function deleteError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'name_mismatch') return "The name doesn't match. Type it exactly as shown.";
    if (err.status === 404) return 'This template no longer exists.';
  }
  return "Couldn't delete the template.";
}

export default function DeleteTemplateModal({ template, dpiChildren = [], onDeleted, onClose }: {
  /** The row to delete: a top-level template or one DPI child. */
  template: LabelTemplate;
  /** A parent's DPI versions from the tree, for their versions and states. */
  dpiChildren?: LabelTemplateChild[];
  onDeleted: () => void;
  onClose: () => void;
}) {
  const isChild = !!template.parent_id;
  const [summary, setSummary] = useState<LabelTemplateDeleteSummary | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let live = true;
    setLoadError(false);
    getLabelTemplateDeleteSummary(template.id)
      .then((s) => { if (live) setSummary(s); })
      .catch(() => { if (live) setLoadError(true); });
    return () => { live = false; };
  }, [template.id]);

  useEffect(() => load(), [load]);

  const confirmed = isChild || typed === template.name;
  const destroy = async () => {
    if (!summary || !confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (isChild) await deleteLabelTemplateForGood(template.id);
      else await deleteLabelTemplateForGood(template.id, typed);
      onDeleted();
    } catch (err) {
      setError(deleteError(err));
      setBusy(false);
    }
  };

  const count = summary?.children.length ?? 0;
  const button = isChild ? 'Delete this DPI'
    : count ? `Delete template and ${plural(count, 'DPI version', 'DPI versions')}` : 'Delete template';
  const hint = isChild
    ? (template.is_old
      ? 'This removes the kept copy. The parent and its other DPI versions stay as they are.'
      : `This removes the ${template.dpi_key} DPI version. Add DPI on the parent brings it back, generated from the parent.`)
    : (count ? 'This removes the template and everything under it.' : 'This removes the template for good.');

  const byName = new Map(dpiChildren.map((c) => [c.name, c]));
  const rows = (summary?.children ?? []).map((name) => {
    const c = byName.get(name);
    return {
      key: name,
      cells: [
        <span className="cell-top">{name}</span>,
        c ? templateVersionLabel(c) : '—',
        c ? (
          <span className="lt-chips">
            {childStateChips(c, template).map((chip) => (
              <span key={chip.text} className={`chip ${chip.color}`}>{chip.text}</span>
            ))}
          </span>
        ) : '—',
      ],
    };
  });

  const generated = summary?.generated_labels ?? 0;

  return (
    <ListDialog label={isChild ? 'Delete DPI version' : 'Delete template'} eyebrow="Label templates · Delete"
      title={`Delete “${template.name}”?`} hint={hint} card="lt-delete-card" busy={busy} onClose={onClose}
      foot={(
        <>
          <button type="button" className="btn-solid btn-danger" disabled={!summary || !confirmed || busy}
            onClick={() => void destroy()}>
            {busy ? 'Deleting…' : button}
          </button>
          <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </>
      )}>
      {loadError ? (
        <div className="lt-delete-load">
          <span className="pf-error">Couldn&apos;t count what goes with it.</span>
          <button type="button" className="mini-btn" onClick={load}>Retry</button>
        </div>
      ) : summary === null ? (
        <p className="page-hint">Counting what goes with it…</p>
      ) : (
        <div className="lt-delete">
          {count > 0 && (
            <DataTable ariaLabel="DPI versions deleted with it" rows={rows}
              columns={[
                { key: 'name', label: 'DPI version' },
                { key: 'version', label: 'Version', mono: true, width: '90px' },
                { key: 'state', label: 'State', width: '42%' },
              ]} />
          )}
          <p className="page-hint lt-delete-note">
            {generated
              ? `${plural(generated, 'generated label goes', 'generated labels go')} with it; they can be generated again. Kiosks keep their copies until their next regeneration.`
              : 'No labels have been generated from it.'}
          </p>
          {!isChild && (
            <div className="pf-form">
              <div className="full">
                {/* the name keeps its case: the match is case-sensitive */}
                <label htmlFor="lt-delete-name">
                  Type <span className="lt-confirm-name">{template.name}</span> to confirm
                </label>
                <input id="lt-delete-name" value={typed} autoComplete="off" spellCheck={false} disabled={busy}
                  autoFocus onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void destroy(); }} />
              </div>
            </div>
          )}
        </div>
      )}
    </ListDialog>
  );
}
