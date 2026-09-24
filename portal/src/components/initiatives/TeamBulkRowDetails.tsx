/**
 * TeamBulkRowDetails — the Details cell of one TeamBulkUpload preview line:
 * a match dropdown per unresolved value (candidates first, then — for an
 * unknown value — every worker / site / role), the row's error sentences,
 * an update's diff with its Update box, and the Skip box. The match menus
 * are portaled so the preview table keeps its sideways scroll. Pure rendering;
 * the pane owns overrides / skip / approvals and re-previews.
 */
import { useId } from 'react';

import type { TeamBulkIssue, TeamBulkRow } from '../../lib/api';
import ComboBox, { type ComboOption } from '../ComboBox';
import { describeDiff } from '../bulk/BulkUpload';

export type TeamField = TeamBulkIssue['field'];
export type TeamFieldOptions = Partial<Record<TeamField, ComboOption[]>>;
/** Fields whose full list failed to load — their dropdowns say so, and reopening retries. */
export type TeamFieldFailed = Partial<Record<TeamField, boolean>>;

/** The issue's candidates, then (unknown values only) the rest of the field's list. */
export function matchOptions(issue: TeamBulkIssue, all: TeamFieldOptions): ComboOption[] {
  const picks = issue.candidates.map((c) => ({ value: c.id, label: c.label, sub: c.detail || null }));
  if (issue.kind !== 'unknown') return picks;
  const seen = new Set(picks.map((p) => p.value));
  return [...picks, ...(all[issue.field] ?? []).filter((o) => !seen.has(o.value))];
}

function issueText(issue: TeamBulkIssue): string {
  const n = issue.candidates.length;
  return issue.kind === 'ambiguous'
    ? `“${issue.value}” matches ${n} ${issue.field}s — pick one.`
    : `No ${issue.field} named “${issue.value}” — pick one.`;
}

interface Props {
  row: TeamBulkRow;
  options: TeamFieldOptions;
  failed: TeamFieldFailed;
  picked: Partial<Record<TeamField, string>>;
  skipped: boolean;
  approved: boolean;
  disabled: boolean;
  onPick(field: TeamField, id: string): void;
  onOpenField(field: TeamField): void;
  onClearPicks(): void;
  onToggleSkip(): void;
  onToggleApprove(): void;
}

export default function TeamBulkRowDetails({
  row, options, failed, picked, skipped, approved, disabled,
  onPick, onOpenField, onClearPicks, onToggleSkip, onToggleApprove,
}: Props) {
  const n = row.row;
  const canSkip = row.action === 'attention' || row.action === 'error' || row.action === 'skipped';
  const hasPicks = Object.keys(picked).length > 0;
  const skipHintId = useId();
  return (
    <div className="bulk-diff">
      {row.action !== 'skipped' && row.issues.map((issue) => (
        <div key={issue.field} className="bulk-file-row">
          <span>{issueText(issue)}</span>
          <ComboBox
            portal
            ariaLabel={`Match ${issue.field} for row ${n}`}
            options={matchOptions(issue, options)}
            value={picked[issue.field] ?? ''}
            placeholder={`Pick a ${issue.field}…`}
            disabled={disabled}
            onChange={(id) => { if (id) onPick(issue.field, id); }}
            onOpen={issue.kind === 'unknown' ? () => onOpenField(issue.field) : undefined}
          />
          {issue.kind === 'unknown' && failed[issue.field] && (
            <span className="set-note">Could not load the list — reopen to retry.</span>
          )}
        </div>
      ))}
      {row.action !== 'skipped' && row.errors.map((e) => <span key={e} className="pf-error">{e}</span>)}
      {row.action === 'update' && row.diff && (
        <>
          {describeDiff(row.diff).map((d) => (
            <span key={d.field}>{d.field}: {d.from ? `${d.from} → ` : ''}{d.to}</span>
          ))}
          <label>
            <input type="checkbox" aria-label={`Update row ${n}`} checked={approved}
                   disabled={disabled} onChange={onToggleApprove} />
            {' '}Update
          </label>
        </>
      )}
      {canSkip && (
        <>
          <label>
            <input type="checkbox" aria-label={`Skip row ${n}`} checked={skipped}
                   aria-describedby={skipped ? skipHintId : undefined}
                   disabled={disabled} onChange={onToggleSkip} />
            {' '}Skip
          </label>
          {skipped && <span id={skipHintId}>Skipped — uncheck to undo.</span>}
        </>
      )}
      {hasPicks && row.action !== 'skipped' && (
        <button type="button" className="mini-btn" disabled={disabled}
                aria-label={`Clear picks for row ${n}`} onClick={onClearPicks}>
          Clear picks
        </button>
      )}
    </div>
  );
}
