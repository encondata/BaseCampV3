/**
 * AssetBulkRowDetails — the Details cell of one AssetBulkUpload preview
 * line, in the shared BulkUpload / TeamBulkRowDetails markup: the row's
 * error sentences as .pf-error spans, then one .bulk-diff block holding an
 * update's diff with its Update box, a match dropdown per unresolved value
 * (candidates first, then — for an unknown model / client / site / status —
 * the whole list), the Skip box, and Clear picks. The match menus are
 * portaled so the preview table keeps its sideways scroll. Pure rendering;
 * the pane owns overrides / skip / approvals and re-previews.
 */
import { useId } from 'react';

import {
  listAssetModels, listAssetStatuses, listClients, listSites,
  type AssetBulkIssue, type AssetBulkRow,
} from '../../lib/api';
import ComboBox, { type ComboOption } from '../ComboBox';
import { describeDiff } from '../bulk/BulkUpload';

export type AssetField = AssetBulkIssue['field'];
/** Fields with a full list behind their unknown values (an asset is only ever ambiguous). */
export type AssetListField = Exclude<AssetField, 'asset'>;
export type AssetFieldOptions = Partial<Record<AssetListField, ComboOption[]>>;
/** Fields whose full list failed to load — their dropdowns say so, and reopening retries. */
export type AssetFieldFailed = Partial<Record<AssetListField, boolean>>;

/** The whole list behind an unknown value's dropdown, loaded lazily by the pane. */
export const FIELD_LOADERS: Record<AssetListField, () => Promise<ComboOption[]>> = {
  model: async () => (await listAssetModels())
    .map((m) => ({ value: m.id, label: `${m.make} ${m.model}`.trim(), sub: m.category || null })),
  client: async () => (await listClients()).filter((c) => !c.archived_at)
    .map((c) => ({ value: c.id, label: c.name })),
  site: async () => (await listSites()).filter((s) => !s.archived_at)
    .map((s) => ({ value: s.id, label: s.name })),
  status: async () => (await listAssetStatuses()).filter((s) => s.is_active)
    .map((s) => ({ value: s.key, label: s.label, sub: s.key })),
};

const PLURAL: Record<AssetField, string> = {
  asset: 'assets', model: 'models', client: 'clients', site: 'sites', status: 'statuses',
};
const article = (field: AssetField) => (field === 'asset' ? 'an' : 'a');

/** The issue's candidates, then (unknown values only) the rest of the field's list. */
export function matchOptions(issue: AssetBulkIssue, all: AssetFieldOptions): ComboOption[] {
  const picks = issue.candidates.map((c) => ({ value: c.id, label: c.label, sub: c.detail || null }));
  if (issue.kind !== 'unknown' || issue.field === 'asset') return picks;
  const seen = new Set(picks.map((p) => p.value));
  return [...picks, ...(all[issue.field] ?? []).filter((o) => !seen.has(o.value))];
}

function issueText(issue: AssetBulkIssue): string {
  const n = issue.candidates.length;
  return issue.kind === 'ambiguous'
    ? `“${issue.value}” matches ${n} ${PLURAL[issue.field]} — pick one.`
    : `No ${issue.field} named “${issue.value}” — pick one.`;
}

interface Props {
  row: AssetBulkRow;
  options: AssetFieldOptions;
  failed: AssetFieldFailed;
  picked: Partial<Record<AssetField, string>>;
  skipped: boolean;
  approved: boolean;
  disabled: boolean;
  onPick(field: AssetField, id: string): void;
  onOpenField(field: AssetListField): void;
  onClearPicks(): void;
  onToggleSkip(): void;
  onToggleApprove(): void;
}

export default function AssetBulkRowDetails({
  row, options, failed, picked, skipped, approved, disabled,
  onPick, onOpenField, onClearPicks, onToggleSkip, onToggleApprove,
}: Props) {
  const n = row.row;
  const canSkip = row.action === 'attention' || row.action === 'error' || row.action === 'skipped';
  const hasPicks = Object.keys(picked).length > 0;
  const skipHintId = useId();
  return (
    <>
      {row.action !== 'skipped' && row.errors.map((e) => <span key={e} className="pf-error">{e}</span>)}
      <div className="bulk-diff">
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
        {row.action !== 'skipped' && row.issues.map((issue) => {
          const { field } = issue;
          const listed: AssetListField | null =
            field !== 'asset' && issue.kind === 'unknown' ? field : null;
          return (
            <div key={field} className="bulk-file-row">
              <span>{issueText(issue)}</span>
              <ComboBox
                portal
                ariaLabel={`Match ${field} for row ${n}`}
                options={matchOptions(issue, options)}
                value={picked[field] ?? ''}
                placeholder={`Pick ${article(field)} ${field}…`}
                disabled={disabled}
                onChange={(id) => { if (id) onPick(field, id); }}
                onOpen={listed ? () => onOpenField(listed) : undefined}
              />
              {listed && failed[listed] && (
                <span className="set-note">Could not load the list — reopen to retry.</span>
              )}
            </div>
          );
        })}
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
