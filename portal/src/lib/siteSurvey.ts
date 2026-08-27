/**
 * Site survey — pure display logic for the two survey lists (curated
 * `GET /sites/{id}/survey`, registry-ordered with answers merged in by the
 * server, and raw `GET /sites/{id}/survey/raw`, the append-only submission
 * trail). No client-side schema merge needed: the curated rows already
 * carry label/group/kind/options alongside the answer. Mirrors the
 * lib/scans.ts pattern (processedScanCellText/rawScanCellText).
 */

import type { RawSurveyRow, SiteSurveyRow } from './api';

export const SITE_SURVEY_ERRORS: Record<string, string> = {
  unknown_survey_field: 'A survey field is no longer valid — reload and retry.',
  invalid_survey_value: 'A survey answer has the wrong format.',
  survey_value_not_found: 'That answer was already cleared.',
  forbidden: 'You do not have permission to change sites.',
};

/** bool -> Yes/No, unanswered (null) -> em dash, everything else as text. */
export function surveyValueText(row: SiteSurveyRow): string {
  if (row.value === null) return '—';
  if (row.kind === 'bool') return row.value ? 'Yes' : 'No';
  return String(row.value);
}

/** Column-menu accessor for the curated list — mirrors SiteSurveyList's
 *  cell renderer exactly (including '—' fallbacks). */
export function surveyCellText(row: SiteSurveyRow, colKey: string): string {
  switch (colKey) {
    case 'field': return row.label;
    case 'group': return row.group_label;
    case 'value': return surveyValueText(row);
    case 'updated_by': return row.updated_by_name ?? '—';
    case 'updated': return row.updated_at ? new Date(row.updated_at).toLocaleString() : '—';
    default: return '';
  }
}

export function surveySearchText(row: SiteSurveyRow): string {
  return [row.label, row.group_label, surveyValueText(row), row.updated_by_name]
    .filter(Boolean).join(' ').toLowerCase();
}

/** Filled-vs-total for the panel eyebrow badge ("12/17 filled"). */
export function filledCount(rows: SiteSurveyRow[]): { filled: number; total: number } {
  return { filled: rows.filter((r) => r.value !== null).length, total: rows.length };
}

/** Column-menu accessor for the raw list — mirrors RawSurveyList's cell
 *  renderer exactly. `registered` distinguishes an entry against a live
 *  registry field from a stray/legacy key (e.g. a since-removed field, or
 *  a bad device submission) — those show '—' rather than a misleading No. */
export function rawSurveyCellText(row: RawSurveyRow, colKey: string): string {
  switch (colKey) {
    case 'field': return row.field_key;
    case 'value': return row.value === null ? '—' : String(row.value);
    case 'registered': return row.registered ? 'Yes' : '—';
    case 'source': return row.source || '—';
    case 'submitted_by': return row.submitted_by_name ?? '—';
    case 'device': return row.device_id || '—';
    case 'captured': return new Date(row.captured_at).toLocaleString();
    case 'ingested': return new Date(row.created_at).toLocaleString();
    default: return '';
  }
}

export function rawSurveySearchText(row: RawSurveyRow): string {
  return [
    row.field_key, row.value === null ? '' : String(row.value), row.source,
    row.submitted_by_name, row.device_id,
  ].filter(Boolean).join(' ').toLowerCase();
}
