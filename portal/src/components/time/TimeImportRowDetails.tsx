/**
 * TimeImportRowDetails — the Details cell of one TimeImportUpload preview
 * line, in TeamBulkRowDetails' markup. It holds the row's error sentences
 * as .pf-error spans, then one .bulk-diff block with:
 *   - an add's shift, length, job and site lines, or "Already there" for a duplicate;
 *   - a portaled match dropdown per unresolved worker / job / site
 *     (candidates first, then, for an unknown value, the whole list);
 *   - the Skip box, and Clear picks.
 * Pure rendering; the pane owns overrides and skips, and re-previews.
 */
import { useId } from 'react';

import type { TimeImportField, TimeImportIssue, TimeImportRow } from '../../lib/api';
import { formatMinutes } from '../../lib/timeFormat';
import ComboBox, { type ComboOption } from '../ComboBox';

export type TimeFieldOptions = Partial<Record<TimeImportField, ComboOption[]>>;
/** Fields whose full list failed to load; their dropdowns say so, and reopening retries. */
export type TimeFieldFailed = Partial<Record<TimeImportField, boolean>>;

/** The issue's candidates, then (unknown values only) the rest of the field's list. */
export function matchOptions(issue: TimeImportIssue, all: TimeFieldOptions): ComboOption[] {
  const picks = issue.candidates.map((c) => ({ value: c.id, label: c.label, sub: c.detail || null }));
  if (issue.kind !== 'unknown') return picks;
  const seen = new Set(picks.map((p) => p.value));
  return [...picks, ...(all[issue.field] ?? []).filter((o) => !seen.has(o.value))];
}

function issueText(issue: TimeImportIssue): string {
  return issue.kind === 'ambiguous'
    ? `“${issue.value}” matches ${issue.candidates.length} ${issue.field}s — pick one.`
    : `No ${issue.field} named “${issue.value}” — pick one.`;
}

/** "Sep 24, 7:00 AM – 3:30 PM EDT · 8h (30m break)" */
export function shiftLine(row: TimeImportRow): string {
  if (!row.shift) return '';
  const length = row.minutes === null ? '' : ` · ${formatMinutes(row.minutes)}`;
  const brk = row.break_minutes ? ` (${formatMinutes(row.break_minutes)} break)` : '';
  return `${row.shift}${length}${brk}`;
}

interface Props {
  row: TimeImportRow;
  options: TimeFieldOptions;
  failed: TimeFieldFailed;
  picked: Partial<Record<TimeImportField, string>>;
  skipped: boolean;
  disabled: boolean;
  onPick(field: TimeImportField, id: string): void;
  onOpenField(field: TimeImportField): void;
  onClearPicks(): void;
  onToggleSkip(): void;
}

export default function TimeImportRowDetails({
  row, options, failed, picked, skipped, disabled, onPick, onOpenField, onClearPicks, onToggleSkip,
}: Props) {
  const n = row.row;
  const canSkip = row.action === 'attention' || row.action === 'error' || row.action === 'skipped';
  const hasPicks = Object.keys(picked).length > 0;
  const skipHintId = useId();
  return (
    <>
      {row.action !== 'skipped' && row.errors.map((e, i) => (
        <span key={`${i}-${e}`} className="pf-error">{e}</span>
      ))}
      <div className="bulk-diff">
        {(row.action === 'add' || row.action === 'duplicate') && row.shift && <span>{shiftLine(row)}</span>}
        {row.action === 'add' && (
          <>
            <span>Job: {row.job_name || '—'}</span>
            <span>Site: {row.site_name || '—'}</span>
          </>
        )}
        {row.action === 'duplicate' && <span>Already there. Skipped when you add.</span>}
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
    </>
  );
}
